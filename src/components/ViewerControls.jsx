import { Cuboid, Grid3X3, Rotate3D, Scan } from 'lucide-react';

const presets = [
  ['iso', '斜め'],
  ['front', '正面'],
  ['top', '上面'],
  ['right', '右面'],
];

export default function ViewerControls({
  viewMode, showGrid, autoRotate, viewPreset,
  onFit, onToggleWireframe, onToggleGrid, onToggleAutoRotate, onSelectPreset,
}) {
  return (
    <>
      <div className="viewer-tools">
        <button type="button" title="全体を表示 (F)" onClick={onFit}><Scan size={18} /></button>
        <span />
        <button
          type="button"
          title="ワイヤーフレーム"
          className={viewMode === 'wireframe' ? 'active' : ''}
          aria-pressed={viewMode === 'wireframe'}
          onClick={onToggleWireframe}
        >
          <Cuboid size={18} />
        </button>
        <button
          type="button"
          title="グリッド"
          className={showGrid ? 'active' : ''}
          aria-pressed={showGrid}
          onClick={onToggleGrid}
        >
          <Grid3X3 size={18} />
        </button>
        <button
          type="button"
          title="自動回転"
          className={autoRotate ? 'active' : ''}
          aria-pressed={autoRotate}
          onClick={onToggleAutoRotate}
        >
          <Rotate3D size={18} />
        </button>
      </div>
      <div className="view-presets">
        {presets.map(([key, label]) => (
          <button
            type="button"
            key={key}
            className={viewPreset === key ? 'active' : ''}
            aria-pressed={viewPreset === key}
            onClick={() => onSelectPreset(key)}
          >
            {label}
          </button>
        ))}
      </div>
    </>
  );
}
