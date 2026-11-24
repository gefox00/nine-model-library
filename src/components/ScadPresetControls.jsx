import { useId, useState } from 'react';
import { Download, Save, Upload } from 'lucide-react';

export default function ScadPresetControls({ presets, canEdit, canSave, disabled, onApply }) {
  const inputId = useId();
  const [selectedId, setSelectedId] = useState('');
  const [name, setName] = useState('');
  const [notice, setNotice] = useState('');
  const selected = presets.entries?.find(entry => entry.id === selectedId);
  const stopped = disabled || presets.busy || !presets.entries;

  function select(id) {
    setSelectedId(id);
    setName(presets.entries.find(entry => entry.id === id)?.name || '');
    setNotice('');
  }

  async function save(id) {
    setNotice('');
    const result = await presets.save(id, name);
    if (!result) return;
    setSelectedId(result.id);
    setName(result.presets.find(entry => entry.id === result.id)?.name || name);
    setNotice('プリセットを保存しました');
  }

  async function apply() {
    setNotice('');
    if (!(await presets.apply(selectedId))) return;
    onApply();
    setNotice('編集欄に反映しました。形状を見るにはプレビューを更新してください。');
  }

  async function remove() {
    setNotice('');
    if (!(await presets.remove(selectedId))) return;
    select('');
    setNotice('プリセットを削除しました');
  }

  async function transfer(importing) {
    setNotice('');
    const result = await (importing ? presets.importJson() : presets.exportJson());
    if (result) setNotice(importing ? `${result.count}件のプリセットを追加しました` : 'プリセットをJSONに書き出しました');
  }

  const canWrite = !stopped && canSave && name.trim().length > 0;
  return <details open className="scad-presets">
    <summary>プリセット{presets.entries && <span>{presets.entries.length}件</span>}</summary>
    <div className="scad-preset-fields" aria-busy={presets.busy}>
      {presets.error && <p className="scad-field-error" role="alert">{presets.error}</p>}
      <label htmlFor={`${inputId}-saved`}>保存したプリセット</label>
      <select id={`${inputId}-saved`} value={selected?.id || ''} onChange={event => select(event.target.value)} disabled={stopped || !presets.entries.length}>
        <option value="">{!presets.entries ? '一覧を読み込み中' : presets.entries.length ? '選択してください' : '保存済みプリセットなし'}</option>
        {presets.entries?.map(entry => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
      </select>
      {selected && <div className="scad-preset-buttons">
        <button type="button" className="secondary-button" onClick={apply} disabled={stopped || !canEdit}>適用</button>
        <button type="button" className="secondary-button" onClick={remove} disabled={stopped}>削除</button>
      </div>}
      {canEdit && <>
        <label htmlFor={`${inputId}-name`}>プリセット名</label>
        <input id={`${inputId}-name`} value={name} maxLength={80} disabled={stopped} onChange={event => setName(event.target.value)}/>
        <div className="scad-preset-buttons">
          <button type="button" className="secondary-button" onClick={() => save(null)} disabled={!canWrite}><Save size={12}/>新規保存</button>
          {selected && <button type="button" className="secondary-button" onClick={() => save(selected.id)} disabled={!canWrite}>選択を上書き</button>}
        </div>
        <p className="scad-subtle">編集した値を保存します。未指定の項目はSCADの既定値を使います。</p>
      </>}
      <div className="scad-preset-buttons">
        <button type="button" className="secondary-button" onClick={() => transfer(true)} disabled={stopped || !canEdit}><Upload size={12}/>JSONを読み込む</button>
        <button type="button" className="secondary-button" onClick={() => transfer(false)} disabled={stopped || !presets.entries.length}><Download size={12}/>JSONに書き出す</button>
      </div>
      {notice && <p className="scad-preset-notice" role="status">{notice}</p>}
    </div>
  </details>;
}
