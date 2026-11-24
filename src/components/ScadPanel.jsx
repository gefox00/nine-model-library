import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { AlertCircle, Check, Download, Loader2, Play, RotateCcw, Settings2, Square } from 'lucide-react';
import ScadPresetControls from './ScadPresetControls.jsx';
import './ScadPanel.css';

const MODES = [
  ['current', '現在のモデルをSTL出力'],
  ['single', '指定したパーツを出力'],
  ['selected', '選択したパーツを出力'],
  ['all', '全パーツを一括出力'],
];
const hasOwn = (object, name) => Object.prototype.hasOwnProperty.call(object || {}, name);
const displayValue = value => Array.isArray(value) ? `[${value.join(', ')}]` : String(value ?? '');
const sameValue = (a, b) => Array.isArray(a) || Array.isArray(b) ? JSON.stringify(a) === JSON.stringify(b) : Object.is(a, b);

function numericInput(text, parameter, defaultValue = parameter.defaultValue) {
  const trimmed = String(text).trim();
  if (!trimmed) return { error: '数値を入力してください' };
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed)) return { error: '有効な数値を入力してください' };
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return { error: '有限の数値を入力してください' };
  if (value === defaultValue) return { value };
  if (Number.isFinite(parameter.min) && value < parameter.min) return { error: `${parameter.min} 以上にしてください` };
  if (Number.isFinite(parameter.max) && value > parameter.max) return { error: `${parameter.max} 以下にしてください` };
  if (Number.isFinite(parameter.step) && parameter.step > 0) {
    const ticks = (value - (parameter.min ?? 0)) / parameter.step;
    if (!Number.isFinite(ticks) || Math.abs(ticks - Math.round(ticks)) > 1e-7) return { error: `刻み ${parameter.step} に合わせてください` };
  }
  return { value };
}

function isViewOption(option) {
  // Exact view names only: a real part such as "assembly_plate" must remain.
  const names = [option.value, option.label].filter(value => typeof value === 'string');
  return names.some(name => {
    const normalized = name.trim().toLocaleLowerCase().replace(/[\s_\-()[\]（）]+/g, '');
    return /^(?:assembly|assembled|preview|explode|exploded|overview)(?:view|preview|only)?$/.test(normalized)
      || /^(?:組立|組み立て|組みたて|組立て|組立図|組立表示|組み立て表示|全体|全体表示|プレビュー|分解|分解図|分解表示|展開図)$/.test(normalized);
  });
}

function parameterError(parameter, current, draft) {
  if (parameter.options?.length) {
    return sameValue(current, parameter.defaultValue) || parameter.options.some(option => sameValue(option.value, current)) ? null : '一覧から値を選択してください';
  }
  if (parameter.type === 'number') return numericInput(draft ?? current, parameter).error || null;
  if (parameter.type === 'vector') {
    const parts = draft ?? current;
    if (!Array.isArray(parts) || parts.length !== parameter.defaultValue?.length) return 'ベクトルの要素数が一致しません';
    for (let i = 0; i < parts.length; i++) {
      const error = numericInput(parts[i], parameter, parameter.defaultValue[i]).error;
      if (error) return `${i + 1} 番目: ${error}`;
    }
  }
  if (parameter.type === 'boolean' && typeof current !== 'boolean') return 'オン・オフを選択してください';
  if (parameter.type === 'string' && typeof current !== 'string') return '文字列を入力してください';
  return null;
}

function rangeHint(parameter) {
  const parts = [];
  if (Number.isFinite(parameter.min) || Number.isFinite(parameter.max)) parts.push(`${parameter.min ?? '制限なし'} 〜 ${parameter.max ?? '制限なし'}`);
  if (Number.isFinite(parameter.step) && parameter.step > 0) parts.push(`刻み ${parameter.step}`);
  return parts.join(' · ');
}

export default function ScadPanel({
  item,
  parametersInfo,
  values = {},
  presets,
  onValuesChange,
  onReset,
  onPreview,
  previewPhase,
  previewWarnings = [],
  onExport,
  onCancelExport,
  exportState,
  exportResult,
  canRender,
  onOpenSettings,
}) {
  const idPrefix = useId();
  const exportRef = useRef(null);
  const parameters = parametersInfo?.parameters || [];
  const [drafts, setDrafts] = useState({});
  const [mode, setMode] = useState('current');
  const [selectorName, setSelectorName] = useState('');
  const [singleIndex, setSingleIndex] = useState('0');
  const [selectedIndices, setSelectedIndices] = useState([]);
  const parameterSignature = JSON.stringify(parameters.map(parameter => [parameter.name, parameter.type, parameter.defaultValue, parameter.options]));
  const selectors = useMemo(() => parameters.filter(parameter => parameter.options?.length >= 2), [parameterSignature]);
  const selector = selectors.find(parameter => parameter.name === selectorName)
    || selectors.find(parameter => parameter.name === parametersInfo?.selector)
    || selectors[0];
  const partOptions = selector?.options || [];
  const isExporting = ['running', 'stopping'].includes(exportState?.status);
  const isPreviewing = previewPhase === 'loading';
  const loading = parametersInfo == null;
  const valueOf = parameter => hasOwn(values, parameter.name) ? values[parameter.name] : parameter.defaultValue;
  const errors = parameters.map(parameter => [parameter.name, parameterError(parameter, valueOf(parameter), drafts[parameter.name])]).filter(([, error]) => error);
  const errorMap = new Map(errors);
  const grouped = new Map();
  for (const parameter of parameters) {
    const name = parameter.group || 'パラメータ';
    if (!grouped.has(name)) grouped.set(name, []);
    grouped.get(name).push(parameter);
  }

  useEffect(() => {
    setDrafts({});
    setMode('current');
    setSelectorName('');
    setSingleIndex('0');
    setSelectedIndices([]);
  }, [item?.id, item?.modifiedAt, parameterSignature]);

  const defaultSelectedIndex = selector ? partOptions.findIndex(option => sameValue(option.value, valueOf(selector))) : -1;
  useEffect(() => {
    setSingleIndex(String(defaultSelectedIndex >= 0 ? defaultSelectedIndex : 0));
    setSelectedIndices([]);
  }, [selector?.name]);

  function commit(name, value) {
    onValuesChange?.({ ...values, [name]: value });
  }
  function changeNumber(parameter, text) {
    setDrafts(previous => ({ ...previous, [parameter.name]: text }));
    const parsed = numericInput(text, parameter);
    if (!parsed.error) commit(parameter.name, parsed.value);
  }
  function changeVector(parameter, index, text) {
    const currentValue = valueOf(parameter);
    const current = drafts[parameter.name] || (Array.isArray(currentValue) ? currentValue : parameter.defaultValue || []).map(displayValue);
    const next = [...current];
    next[index] = text;
    setDrafts(previous => ({ ...previous, [parameter.name]: next }));
    const parsed = next.map((part, partIndex) => numericInput(part, parameter, parameter.defaultValue[partIndex]));
    if (parsed.every(part => !part.error)) commit(parameter.name, parsed.map(part => part.value));
  }
  function reset() {
    setDrafts({});
    onReset?.();
  }
  function jumpToExport() {
    exportRef.current?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
    exportRef.current?.focus({ preventScroll: true });
  }
  function renderField(parameter) {
    const current = valueOf(parameter);
    const inputId = `${idPrefix}-${parameter.name}`;
    const label = parameter.label || parameter.name;
    const error = errorMap.get(parameter.name);
    const hint = rangeHint(parameter);
    const accessibility = {
      'aria-invalid': Boolean(error),
      'aria-describedby': `${inputId}-help`,
      disabled: isExporting || presets?.busy,
    };
    let control;
    if (parameter.options?.length) {
      const index = parameter.options.findIndex(option => sameValue(option.value, current));
      control = <select id={inputId} {...accessibility} value={String(index)} onChange={event => {
        const option = parameter.options[Number(event.target.value)];
        if (option) commit(parameter.name, option.value);
      }}>{index < 0 && <option value="-1" disabled>{sameValue(current, parameter.defaultValue) ? `既定値 (${displayValue(current)})` : '値を選択'}</option>}{parameter.options.map((option, index) => <option key={index} value={index}>{option.label || displayValue(option.value)}</option>)}</select>;
    } else if (parameter.type === 'boolean') {
      control = <label className="scad-boolean"><input id={inputId} {...accessibility} type="checkbox" checked={current === true} onChange={event => commit(parameter.name, event.target.checked)}/><span>{current === true ? 'オン' : 'オフ'}</span></label>;
    } else if (parameter.type === 'number') {
      control = <input id={inputId} {...accessibility} type="text" inputMode="decimal" autoComplete="off" spellCheck={false} value={drafts[parameter.name] ?? displayValue(current)} onChange={event => changeNumber(parameter, event.target.value)}/>;
    } else if (parameter.type === 'vector') {
      const parts = drafts[parameter.name] || (Array.isArray(current) ? current : parameter.defaultValue || []).map(displayValue);
      control = <div className="scad-vector" role="group" aria-label={label}>{parts.map((part, index) => <input key={index} {...accessibility} id={index === 0 ? inputId : `${inputId}-${index}`} type="text" inputMode="decimal" autoComplete="off" spellCheck={false} aria-label={`${label} ${index + 1} 番目`} value={part} onChange={event => changeVector(parameter, index, event.target.value)}/>)}</div>;
    } else {
      control = <input id={inputId} {...accessibility} type="text" value={typeof current === 'string' ? current : displayValue(current)} onChange={event => commit(parameter.name, event.target.value)}/>;
    }
    return <div className={`scad-field ${error ? 'has-error' : ''}`} key={parameter.name}>
      <label htmlFor={inputId} title={parameter.name}>{label}</label>
      {label !== parameter.name && <span className="scad-variable-name">{parameter.name}</span>}
      {control}
      <div id={`${inputId}-help`} className="scad-field-help">
        {parameter.description && parameter.description !== label && <p>{parameter.description}</p>}
        {hint && !parameter.options?.length && <span>{hint}</span>}
        {error && <p className="scad-field-error">{error}</p>}
      </div>
    </div>;
  }

  const allOptions = partOptions.filter(option => !isViewOption(option));
  const chosenOptions = mode === 'single' ? [partOptions[Number(singleIndex)]].filter(Boolean)
    : mode === 'selected' ? partOptions.filter((_, index) => selectedIndices.includes(index))
      : mode === 'all' ? allOptions : [];
  const parts = chosenOptions.filter((option, index, all) => all.findIndex(candidate => sameValue(candidate.value, option.value)) === index).map(option => option.value);
  const invalidParts = mode !== 'current' && (!selector || parts.length === 0);
  const actionsDisabled = loading || !canRender || errors.length > 0 || isExporting || presets?.busy;
  const exportDisabled = actionsDisabled || invalidParts || isPreviewing;
  const currentExport = typeof exportState?.current === 'string' ? exportState.current : exportState?.current?.name;
  const outputFiles = exportResult?.files || [];
  const outputFailures = exportResult?.failures || [];
  const diagnostics = parametersInfo?.diagnostics || [];

  return <section className="scad-panel" aria-label="OpenSCADパラメータとSTL出力" data-testid="scad-panel">
    <header className="scad-panel-heading"><div><span>OPENSCAD</span><h2>パラメータ</h2></div><div className="scad-panel-heading-actions"><button type="button" className="scad-export-jump" onClick={jumpToExport}><Download size={13}/>STL出力へ</button><button type="button" className="icon-button" title="パラメータを初期値に戻す" aria-label="パラメータを初期値に戻す" onClick={reset} disabled={loading || isExporting}><RotateCcw size={15}/></button></div></header>
    {!canRender && <div className="scad-callout"><AlertCircle size={15}/><div>{item?.missing ? <p>元ファイルが見つかりません。元の場所に戻すか、移動先から登録してください。</p> : <><p>プレビューとSTL出力にはOpenSCADの設定が必要です。</p><button type="button" onClick={onOpenSettings}><Settings2 size={13}/>OpenSCADを設定</button></>}</div></div>}
    <div className="scad-panel-scroll">
      {presets && <ScadPresetControls key={item?.missing ? 'missing' : 'present'} presets={presets} canEdit={!item?.missing && parameters.length > 0}
        canSave={errors.length === 0} disabled={isExporting} onApply={() => setDrafts({})}/>}
      {loading ? <div className="scad-loading" role="status"><Loader2 size={15} className="spin"/>パラメータを読み込み中</div> : parameters.length ? [...grouped.entries()].map(([group, fields]) => <details className="scad-group" open key={group}><summary>{group}<span>{fields.length}</span></summary><div className="scad-group-fields">{fields.map(renderField)}</div></details>) : <p className="scad-empty">公開パラメータはありません。現在のモデルをプレビュー・出力できます。</p>}
      {diagnostics.length > 0 && <details className="scad-diagnostics"><summary>読み取りについて <span>{diagnostics.length}</span></summary>{diagnostics.map((message, index) => <p key={index}>{typeof message === 'string' ? message : message?.message || String(message)}</p>)}</details>}
      <div className="scad-preview-actions">
        {errors.length > 0 && <p className="scad-invalid-summary" role="status"><AlertCircle size={13}/>{errors.length} 項目の入力を確認してください</p>}
        <button type="button" className="primary-button scad-full-button" onClick={onPreview} disabled={actionsDisabled || isPreviewing}>{isPreviewing ? <Loader2 size={15} className="spin"/> : <Play size={15}/>}プレビューを更新</button>
        <p>値を編集したあと、このボタンで反映。</p>
      </div>
      {previewWarnings.length > 0 && <div className="scad-warnings">{previewWarnings.map((message, index) => <p key={index}><AlertCircle size={12}/>{String(message)}</p>)}</div>}
      <section ref={exportRef} tabIndex={-1} className="scad-export" aria-label="STL出力設定">
        <h3><Download size={15}/>STL出力</h3>
        <fieldset className="scad-export-modes" disabled={isExporting}><legend>出力するモデル</legend>{MODES.map(([value, label]) => <label key={value}><input type="radio" name={`${idPrefix}-export-mode`} value={value} checked={mode === value} onChange={() => setMode(value)}/><span>{label}</span></label>)}</fieldset>
        {mode !== 'current' && (selectors.length ? <div className="scad-part-picker">
          <label htmlFor={`${idPrefix}-selector`}>パーツ切替パラメータ</label>
          <select id={`${idPrefix}-selector`} value={selector?.name || ''} disabled={isExporting} onChange={event => setSelectorName(event.target.value)}>{selectors.map(parameter => <option key={parameter.name} value={parameter.name}>{parameter.label || parameter.name} ({parameter.name})</option>)}</select>
          {mode === 'single' && <><label htmlFor={`${idPrefix}-single-part`}>出力するパーツ</label><select id={`${idPrefix}-single-part`} value={singleIndex} disabled={isExporting} onChange={event => setSingleIndex(event.target.value)}>{partOptions.map((option, index) => <option key={index} value={index}>{option.label || displayValue(option.value)}</option>)}</select></>}
          {mode === 'selected' && <fieldset className="scad-part-checklist" disabled={isExporting}><legend>出力するパーツを選択</legend>{partOptions.map((option, index) => <label key={index}><input type="checkbox" checked={selectedIndices.includes(index)} onChange={event => setSelectedIndices(previous => event.target.checked ? [...previous, index] : previous.filter(value => value !== index))}/><span>{option.label || displayValue(option.value)}</span></label>)}</fieldset>}
          {mode === 'all' && <div className="scad-all-parts"><p>{parts.length} パーツを順番に出力</p><ul>{allOptions.map((option, index) => <li key={index}>{option.label || displayValue(option.value)}</li>)}</ul>{partOptions.length !== allOptions.length && <p className="scad-subtle">組立・プレビュー用の {partOptions.length - allOptions.length} 項目を除外。必要な場合は「指定」「選択」で出力できます。</p>}</div>}
        </div> : <p className="scad-empty">選択肢を2つ以上持つ公開パラメータがありません。現在のモデルを出力できます。</p>)}
        {invalidParts && selectors.length > 0 && <p className="scad-field-error">出力するパーツを1つ以上選んでください。</p>}
        <button type="button" className="secondary-button scad-full-button" disabled={exportDisabled} onClick={() => onExport?.(mode === 'current' ? { selector: null, parts: null } : { selector: selector.name, parts })}><Download size={15}/>{mode === 'current' ? 'STLを書き出す' : `${parts.length} パーツを書き出す`}</button>
        <p className="scad-subtle">保存先を選ぶと、1件ずつSTLを生成します。</p>
      </section>
      {isExporting && <section className="scad-export-progress" role="status" aria-label="STL出力の進捗"><div><Loader2 size={14} className="spin"/><b>STLを生成中</b><span>{exportState.processed || 0} / {exportState.total || 0}</span></div><progress max={Math.max(exportState.total || 0, 1)} value={Math.min(exportState.processed || 0, Math.max(exportState.total || 0, 1))}/>{currentExport && <p title={currentExport}>{currentExport}</p>}<button type="button" className="secondary-button scad-full-button" onClick={onCancelExport} disabled={exportState.status === 'stopping'}><Square size={12}/>{exportState.status === 'stopping' ? '出力を中止中' : 'STL出力を中止'}</button></section>}
      {exportResult && !isExporting && <section className="scad-export-result" aria-label="STL出力結果"><h3>{exportResult.cancelled ? <Square size={13}/> : outputFailures.length ? <AlertCircle size={14}/> : <Check size={15}/>} {exportResult.cancelled ? '出力を中止しました' : 'STL出力結果'}</h3><p>{outputFiles.length} 件を保存{outputFailures.length ? ` · ${outputFailures.length} 件が失敗` : ''}</p>{exportResult.directory && <p className="scad-result-directory" title={exportResult.directory}>{exportResult.directory}</p>}{outputFiles.length > 0 && <details open><summary>保存したファイル</summary><ul>{outputFiles.map((file, index) => <li key={index} title={file.path}>{file.name || file.path}</li>)}</ul></details>}{outputFailures.length > 0 && <details open className="scad-output-failures"><summary>出力できなかったパーツ</summary>{outputFailures.map((failure, index) => <p key={index}>{failure.part != null && <b>{displayValue(failure.part)}: </b>}{failure.error || '出力に失敗しました'}</p>)}</details>}</section>}
    </div>
  </section>;
}
