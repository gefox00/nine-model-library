import { useEffect, useState } from 'react';
import { Cpu, Check, RefreshCw } from 'lucide-react';
import { PREVIEW_MEMORY_CONFIG as config, resolvePreviewLimits, formatMemoryBytes } from '../formats/preview-memory.js';
import './MemorySettings.css';

export default function MemorySettings({ settings, system, onSave, hasSelection, busy }) {
  const saved = settings.memoryBudgetMiB ?? config.defaultBudgetMiB;
  const [draft, setDraft] = useState(String(saved / 1024));
  useEffect(() => setDraft(String(saved / 1024)), [saved]);
  const budgetMiB = Number(draft) * 1024;
  const valid = draft !== '' && Number.isInteger(budgetMiB) && budgetMiB >= config.minBudgetMiB && budgetMiB <= config.maxBudgetMiB;
  const limits = resolvePreviewLimits(valid ? budgetMiB : saved);
  const available = system?.availableMemoryMiB;
  const total = system?.totalMemoryMiB;
  return <div className="settings-section memory-settings" id="preview-memory-settings">
    <h3><Cpu size={18}/>プレビューメモリ</h3>
    <p>大きいモデルを開くときのメモリ予算。増やすと、読み込みサイズ・展開量・描画量の上限が広がる。</p>
    <label className="memory-budget-label" htmlFor="memory-budget">メモリ予算</label>
    <div className="memory-budget-row">
      <input id="memory-budget" aria-label="プレビュー用メモリ予算" type="number" min="0.5" max="32" step="0.5" value={draft} onChange={e => setDraft(e.target.value)} />
      <span>GiB</span><small>現在の設定: {saved / 1024} GiB</small>
    </div>
    <div className="memory-presets">{config.budgetsMiB.map(value => <button type="button" key={value} className={budgetMiB === value ? 'selected' : ''} onClick={() => setDraft(String(value / 1024))}>{value / 1024} GiB{value === config.defaultBudgetMiB ? ' · 標準' : ''}</button>)}</div>
    {total != null && <p className="memory-system">搭載RAM {(total/1024).toFixed(1)} GiB · 空き {((available ?? 0)/1024).toFixed(1)} GiB（取得時）</p>}
    {!valid && <p className="memory-validation" role="alert">0.5〜32 GiBの範囲で指定してね。</p>}
    {valid && available != null && budgetMiB > available && <p className="memory-validation">空きRAMより大きい予算になっている。読み込み時に動作が重くなる可能性がある。</p>}
    <div className="memory-limit-grid" aria-label="メモリ予算に応じた読み込み上限">
      <div><span>元ファイル</span><b>{formatMemoryBytes(limits.fileBytes)}</b></div>
      <div><span>3MFの展開合計</span><b>{formatMemoryBytes(limits.archiveBytes)}</b></div>
      <div><span>単一の形状XML</span><b>{formatMemoryBytes(limits.xmlBytes)}</b></div>
      <div><span>三角形</span><b>{(limits.triangles / 10000).toLocaleString('ja-JP')} 万面</b></div>
    </div>
    <p className="memory-footnote">実際のRAM使用量を固定する上限ではなく、読み込み制限を調整する目安。解析中は予算を超える場合がある。</p>
    <details className="memory-details"><summary>大きいモデルの制約</summary><p>現在の解析方式では、単一XMLは256 MiB、展開合計は2 GiB、三角形は2,400万面まで。予算を増やしてもこの実装上限は残る。設定だけではすべての大容量モデルに対応できない。</p></details>
    <div className="memory-actions">
      <button type="button" className="secondary-button" disabled={!valid || busy || budgetMiB === saved} onClick={() => onSave(budgetMiB, false)}><Check size={15}/>設定を保存</button>
      {hasSelection && <button type="button" className="primary-button" disabled={!valid || busy} onClick={() => onSave(budgetMiB, true)}><RefreshCw size={15}/>保存して再読み込み</button>}
    </div>
    <p className="memory-apply-note">保存した設定は次のモデル読み込みから反映。アプリの再起動は不要。</p>
  </div>;
}
