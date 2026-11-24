import { useEffect, useRef, useState } from 'react';
import { Images, Play, Square, Check, AlertCircle, Loader2, Settings2 } from 'lucide-react';
import './ThumbnailBatchPanel.css';

const initial = { status: 'idle', total: 0, processed: 0, succeeded: 0, failed: 0, skipped: 0, current: null, failures: [] };

export function useThumbnailBatch(onError) {
  const [batch, setBatch] = useState(initial);
  const errorRef = useRef(onError);
  errorRef.current = onError;
  useEffect(() => {
    if (!window.nine?.getThumbnailBatch) return;
    let live = true;
    let gotEvent = false;
    const unsubscribe = window.nine.onThumbnailBatch(state => { gotEvent = true; if (live) setBatch(state); });
    window.nine.getThumbnailBatch().then(state => { if (live && !gotEvent && state) setBatch(state); }).catch(error => errorRef.current?.(error.message));
    return () => { live = false; unsubscribe(); };
  }, []);
  return batch;
}

export default function ThumbnailBatchPanel({ batch, itemCount, onError, onOpenSettings }) {
  const [overwrite, setOverwrite] = useState(false);
  const [pending, setPending] = useState(false);
  const [detailsForBatch, setDetailsForBatch] = useState(null);
  const details = detailsForBatch === batch.id;
  const running = ['running', 'stopping'].includes(batch.status);
  const progress = batch.total ? Math.min(100, (batch.processed / batch.total) * 100) : 0;
  const hasResult = batch.status !== 'idle';

  async function start() {
    if (pending || running) return;
    setPending(true);
    setDetailsForBatch(null);
    // Batch events are authoritative. An IPC reply can arrive after a newer
    // event, for example when a stop request settles immediately.
    try { await window.nine.startThumbnailBatch({ overwrite }); }
    catch (error) { onError?.(error.message); }
    finally { setPending(false); }
  }
  async function stop() {
    setPending(true);
    try { await window.nine.stopThumbnailBatch(); }
    catch (error) { onError?.(error.message); }
    finally { setPending(false); }
  }

  return <section className={`thumbnail-batch ${hasResult ? 'has-result' : ''}`} data-testid="thumbnail-batch" data-status={batch.status}>
    <div className="thumbnail-batch-toolbar">
      <div className="thumbnail-batch-label"><Images size={17}/><div><b>サムネイルをまとめて生成</b><span>全ライブラリ {itemCount} 件を対象に、1件ずつ読み込み・保存</span></div></div>
      <div className="thumbnail-batch-actions">
        <select aria-label="サムネイル生成対象" value={overwrite ? 'all' : 'missing'} disabled={pending || running} onChange={event => setOverwrite(event.target.value === 'all')}><option value="missing">未生成のみ</option><option value="all">すべて再生成</option></select>
        {running ? <button className="secondary-button" disabled={pending || batch.status === 'stopping'} onClick={stop}><Square size={13}/>{batch.status === 'stopping' ? '中止しています…' : '生成を中止'}</button>
          : <button className="secondary-button thumbnail-start" disabled={pending || !itemCount} onClick={start}>{pending ? <Loader2 size={15} className="spin"/> : <Play size={14}/>}サムネイル生成</button>}
      </div>
    </div>
    {hasResult && <div className="thumbnail-batch-result" role="status" aria-live="polite">
      {batch.reportError && <p className="model-warning" role="alert">{batch.reportError}</p>}
      <div className="thumbnail-batch-progress-heading">
        <b>{running ? <><Loader2 size={13} className="spin"/>サムネイル生成中</> : batch.status === 'cancelled' ? <><Square size={12}/>生成を中止</> : <><Check size={14}/>サムネイル生成完了</>}</b>
        <span className="thumbnail-batch-count" data-testid="thumbnail-batch-count">{batch.processed} / {batch.total} 件</span>
        <span>生成 <strong data-testid="thumbnail-batch-succeeded">{batch.succeeded}</strong></span><span>失敗 <strong data-testid="thumbnail-batch-failed">{batch.failed}</strong></span><span>スキップ <strong>{batch.skipped}</strong></span>
        <span className="thumbnail-batch-budget">予算 {((batch.memoryBudgetMiB ?? 2048) / 1024).toLocaleString('ja-JP')} GiB</span>
      </div>
      <div className="thumbnail-batch-progress" role="progressbar" aria-label="サムネイル生成の進捗" aria-valuemin={0} aria-valuemax={batch.total || 1} aria-valuenow={batch.processed}><i style={{ width: `${progress}%` }}/></div>
      {running && <p className="thumbnail-current" title={batch.current?.name}>{batch.current?.name || '次のモデルを準備中…'}</p>}
      {!running && batch.status === 'cancelled' && batch.scope !== 'single' && <p className="thumbnail-current">生成済みの画像は保存済み。「未生成のみ」で残りから再開できる。</p>}
      {batch.failed > 0 && <div className="thumbnail-failure-controls"><button className="text-button" onClick={() => setDetailsForBatch(details ? null : batch.id)} aria-expanded={details}><AlertCircle size={12}/>{details ? '失敗の詳細を閉じる' : `失敗 ${batch.failed} 件の詳細`}</button><button className="text-button" onClick={onOpenSettings}><Settings2 size={12}/>メモリ設定</button></div>}
      {details && <ul className="thumbnail-failures">{batch.failures.map((failure, index) => <li key={`${failure.id}:${index}`}><b>{failure.name}</b><span>{failure.error}</span></li>)}</ul>}
    </div>}
  </section>;
}
