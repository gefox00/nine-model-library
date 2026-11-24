import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Boxes, Search, Plus, FolderPlus, Folder, Heart, Settings2, LayoutGrid, Rows3, RefreshCw, ArrowUpRight, X, FileBox, ChevronRight, Scan, Grid3X3, Rotate3D, Cuboid, Loader2, AlertCircle, Check, FolderOpen, Trash2, Tag, SlidersHorizontal, MousePointer2, HardDrive, Hexagon } from 'lucide-react';
import ModelViewer from './components/ModelViewer.jsx';
import MemorySettings from './components/MemorySettings.jsx';
import ThumbnailBatchPanel, { useThumbnailBatch } from './components/ThumbnailBatchPanel.jsx';
import ModelContextMenu from './components/ModelContextMenu.jsx';

const blank = { items: [], folders: [], settings: {}, status: {} };
const formatSize = n => n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
const date = n => new Date(n).toLocaleDateString('ja-JP', { year: 'numeric', month: 'short', day: 'numeric' });
const formatName = n => n === 'stp' ? 'STEP' : n?.toUpperCase();
const shortPath = path => path?.split(/[\\/]/).filter(Boolean).pop() || path;

export default function App() {
  const [state, setState] = useState(blank);
  const [selectedId, setSelectedId] = useState(null);
  const [contextMenu, setContextMenu] = useState(null);
  const [section, setSection] = useState('all');
  const [search, setSearch] = useState('');
  const [format, setFormat] = useState('all');
  const [sort, setSort] = useState('recent');
  const [layout, setLayout] = useState('grid');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);
  const [metadata, setMetadata] = useState(null);
  const [viewMode, setViewMode] = useState('solid');
  const [showGrid, setShowGrid] = useState(true);
  const [autoRotate, setAutoRotate] = useState(false);
  const [viewPreset, setViewPreset] = useState('iso');
  const [fitToken, setFitToken] = useState(0);
  const [reloadToken, setReloadToken] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [tagText, setTagText] = useState('');
  const [notes, setNotes] = useState('');
  const searchRef = useRef(null);
  const toastTimer = useRef(null);

  function notify(message, error = false) {
    clearTimeout(toastTimer.current);
    setToast({ message, error });
    toastTimer.current = setTimeout(() => setToast(null), error ? 8500 : 4500);
  }
  const thumbnailBatch = useThumbnailBatch(message => notify(message, true));
  const generatingThumbnails = ['running', 'stopping'].includes(thumbnailBatch.status);
  async function action(fn, message) {
    setBusy(true);
    try { const result = await fn(); if (result?.items) setState(result); if (message) notify(message); return result; }
    catch (e) { notify(e.message?.replace(/^Error invoking remote method '[^']+': Error: /, '') || String(e), true); }
    finally { setBusy(false); }
  }
  useEffect(() => {
    if (!window.nine) return;
    window.nine.getState().then(setState).catch(e => notify(e.message, true));
    return window.nine.onState(setState);
  }, []);
  useEffect(() => {
    const handler = e => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') { e.preventDefault(); searchRef.current?.focus(); }
      if (e.key === 'Escape') setSettingsOpen(false);
      if (e.key.toLowerCase() === 'f' && !['INPUT', 'TEXTAREA'].includes(e.target.tagName)) setFitToken(t => t + 1);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
  const items = useMemo(() => {
    const query = search.toLocaleLowerCase();
    return state.items.filter(item => {
      const folder = state.folders.find(f => f.id === section);
      const folderMatch = !folder || item.path.toLocaleLowerCase().startsWith(folder.path.replace(/[\\/]$/, '').toLocaleLowerCase() + '\\') || item.path.toLocaleLowerCase().startsWith(folder.path.replace(/[\\/]$/, '').toLocaleLowerCase() + '/');
      return (section !== 'favorites' || item.favorite) && folderMatch && (format === 'all' || item.format === format || (format === 'step' && item.format === 'stp')) && (!query || `${item.name} ${item.path} ${(item.tags || []).join(' ')} ${item.notes || ''}`.toLocaleLowerCase().includes(query));
    }).sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name, 'ja') : sort === 'size' ? b.size - a.size : new Date(b.modifiedAt) - new Date(a.modifiedAt));
  }, [state.items, state.folders, search, section, format, sort]);
  const selected = state.items.find(i => i.id === selectedId) || null;
  const contextItem = contextMenu && items.find(item => item.id === contextMenu.id);

  function showModelMenu(event, item, keyboard = false) {
    event.preventDefault();
    event.stopPropagation();
    const trigger = event.currentTarget;
    const bounds = trigger.getBoundingClientRect();
    const useAnchor = keyboard || (event.clientX === 0 && event.clientY === 0);
    setContextMenu({
      id: item.id,
      trigger,
      anchor: { x: useAnchor ? bounds.left + 12 : event.clientX, y: useAnchor ? bounds.top + 12 : event.clientY },
    });
  }

  function closeModelMenu(restoreFocus = false) {
    if (restoreFocus) contextMenu?.trigger.focus({ preventScroll: true });
    setContextMenu(null);
  }

  function modelActionDisabled(id) {
    if (id === 'preview') return false;
    return busy || contextItem.missing || (id === 'thumbnail' && generatingThumbnails);
  }

  async function runModelAction(id) {
    const item = contextItem;
    closeModelMenu(true);
    switch (id) {
      case 'preview':
        setSelectedId(item.id);
        break;
      case 'thumbnail':
        await action(() => window.nine.generateThumbnail(item.id));
        break;
      case 'copy': {
        const result = await action(() => window.nine.copyModel(item.id));
        if (result?.copied) notify(`${item.name} をコピーした`);
        break;
      }
      case 'bambu':
        await action(() => window.nine.openBambu(item.id), 'Bambu Studioにファイルを渡した');
        break;
      case 'trash': {
        const result = await action(() => window.nine.trashModel(item.id));
        if (result?.items) notify(`${item.name} をゴミ箱に移した`);
        break;
      }
    }
  }
  useEffect(() => {
    if (selectedId && !state.items.some(i => i.id === selectedId)) setSelectedId(null);
  }, [state.items, selectedId]);
  useEffect(() => { setMetadata(null); setTagText((selected?.tags || []).join(', ')); setNotes(selected?.notes || ''); }, [selectedId]);
  const title = section === 'favorites' ? 'お気に入り' : section === 'all' ? 'すべてのモデル' : shortPath(state.folders.find(f => f.id === section)?.path) || 'ライブラリ';
  const totalSize = state.items.reduce((sum, i) => sum + i.size, 0);
  async function drop(e) {
    e.preventDefault(); setDragging(false);
    const paths = Array.from(e.dataTransfer.files).map(file => window.nine.droppedPath(file)).filter(Boolean);
    if (paths.length) await action(() => window.nine.importPaths(paths), 'ファイルをライブラリに登録した');
  }
  const importFiles = () => action(() => window.nine.addFiles());
  const addFolder = () => action(() => window.nine.addFolder());
  async function saveMemorySettings(memoryBudgetMiB, reload) {
    const result = await action(() => window.nine.updateSettings({ memoryBudgetMiB }),
      reload ? 'メモリ設定を保存した。モデルを再読み込みする' : 'メモリ設定を保存した。次の読み込みから反映する');
    if (result?.items && reload) { setSettingsOpen(false); setReloadToken(value => value + 1); }
  }

  if (!window.nine) return <div className="desktop-required"><Boxes size={56}/><h1>Nine Model Library</h1><p>このアプリはデスクトップから起動して使う。</p><p>「Nine Model Library.exe」または「起動.cmd」を開いてね。</p></div>;

  return <div className="app-shell" onDragOver={e => { e.preventDefault(); if (e.dataTransfer.types.includes('Files')) setDragging(true); }} onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget)) setDragging(false); }} onDrop={drop}>
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark"><Boxes size={27}/></span><div><b>NINE</b><span>MODEL LIBRARY</span></div><span className="version">01</span></div>
      <div className="workspace-label"><span className="status-dot"/> LOCAL WORKSPACE</div>
      <div className="nav-label">ライブラリ</div>
      <button className={`nav-item ${section === 'all' ? 'active' : ''}`} onClick={() => setSection('all')}><LayoutGrid size={18}/>すべてのモデル<span>{state.items.length}</span></button>
      <button className={`nav-item ${section === 'favorites' ? 'active' : ''}`} onClick={() => setSection('favorites')}><Heart size={18}/>お気に入り<span>{state.items.filter(i => i.favorite).length}</span></button>
      <div className="nav-label folders-heading">監視フォルダ<button className="icon-button" title="監視フォルダを追加" onClick={addFolder}><Plus size={16}/></button></div>
      <div className="folder-list">{state.folders.map(folder => <button key={folder.id} title={folder.path} className={`nav-item folder-item ${section === folder.id ? 'active' : ''}`} onClick={() => setSection(folder.id)}><Folder size={17}/><span>{shortPath(folder.path)}</span><i className="watch-dot"/></button>)}</div>
      {!state.folders.length && <p className="folder-hint">フォルダを追加すると、<br/>新しいモデルを自動で登録。</p>}
      <button className="add-folder" onClick={addFolder}><FolderPlus size={16}/>フォルダを追加</button>
      <div className="sidebar-bottom"><div className="local-note"><HardDrive size={17}/><div><b>このPCに保存</b><span>{formatSize(totalSize)} · 元ファイルを参照</span></div></div><button className="nav-item" onClick={() => setSettingsOpen(true)}><Settings2 size={18}/>設定と連携</button><div className="sidebar-footer">MADE FOR MAKING<span>v0.4.0</span></div></div>
    </aside>
    <main className="main">
      <header className="header"><div className="breadcrumb">ワークスペース<ChevronRight size={14}/><span>{title}</span></div><div className="header-right"><span className="offline-pill"><span className="status-dot"/>ローカルで動作</span><button className="primary-button" disabled={busy} onClick={importFiles}><Plus size={17}/>ファイルを追加</button></div></header>
      <section className="page-heading"><div><div className="eyebrow">YOUR NEXT PRINT STARTS HERE</div><h1>{title}<span>{items.length}</span></h1><p>作ったものも、見つけたものも。次の一個を、ここから。</p></div><div className="heading-actions"><button className="secondary-button" onClick={() => action(() => window.nine.rescan(), 'ライブラリを再スキャンした')} disabled={busy} title="監視フォルダを再スキャン"><RefreshCw size={16} className={busy ? 'spin' : ''}/>再スキャン</button></div></section>
      <ThumbnailBatchPanel batch={thumbnailBatch} itemCount={state.items.length} onError={message => notify(message, true)} onOpenSettings={() => setSettingsOpen(true)}/>
      <div className="library-toolbar"><label className="search"><Search size={17}/><input ref={searchRef} placeholder="ファイル名・タグで検索…" value={search} onChange={e => setSearch(e.target.value)}/><kbd>Ctrl F</kbd></label><div className="format-tabs">{[['all','すべて'],['stl','STL'],['step','STEP'],['3mf','3MF']].map(([value,label]) => <button key={value} className={format === value ? 'selected' : ''} onClick={() => setFormat(value)}>{label}</button>)}</div><div className="toolbar-end"><select aria-label="並び順" value={sort} onChange={e => setSort(e.target.value)}><option value="recent">更新が新しい順</option><option value="name">名前順</option><option value="size">サイズ順</option></select><div className="layout-switch"><button title="グリッド表示" className={layout === 'grid' ? 'selected' : ''} onClick={() => setLayout('grid')}><LayoutGrid size={16}/></button><button title="リスト表示" className={layout === 'list' ? 'selected' : ''} onClick={() => setLayout('list')}><Rows3 size={16}/></button></div></div></div>
      <div className={`content ${selected ? 'has-selection' : ''}`}>
        <section className={`library-panel ${!selected ? 'expanded' : ''}`}>
          <div className="panel-caption"><span>モデル <b>{items.length}</b></span><span>{selected ? '選択してプレビュー' : 'STL / STEP / 3MF'}</span></div>
          {items.length ? <div className={`model-collection ${layout}`}>{items.map(item => <article
            key={item.id}
            role="button"
            tabIndex={0}
            aria-label={`モデル ${item.name}`}
            aria-haspopup="menu"
            aria-expanded={contextItem?.id === item.id}
            className={`model-card ${selectedId === item.id ? 'is-selected' : ''} ${item.missing ? 'is-missing' : ''}`}
            onClick={() => setSelectedId(item.id)}
            onContextMenu={event => showModelMenu(event, item)}
            onKeyDown={event => {
              if (event.target !== event.currentTarget) return;
              if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
                showModelMenu(event, item, true);
              } else if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                setSelectedId(item.id);
              }
            }}>
            <div className={`model-image format-${item.format}`}>
              {item.thumbnail ? <img src={item.thumbnail} alt=""/> : <div className="model-placeholder"><Cuboid strokeWidth={1} size={layout === 'list' ? 28 : 64}/></div>}
              <span className={`format-badge ${item.format}`}>{formatName(item.format)}</span>
              <button className={`favorite-button ${item.favorite ? 'on' : ''}`} title={item.favorite ? 'お気に入りから外す' : 'お気に入りに追加'} onClick={e => { e.stopPropagation(); action(() => window.nine.updateItem(item.id, {favorite:!item.favorite})); }}><Heart size={14} fill={item.favorite ? 'currentColor' : 'none'}/></button>
              {item.missing && <span className="missing-badge">ファイル不在</span>}
            </div><div className="model-card-text"><h3 title={item.name}>{item.name}</h3><div><span>{formatSize(item.size)}</span><span>{date(item.modifiedAt)}</span></div>{item.tags?.length > 0 && <p className="card-tags">{item.tags.slice(0, 2).map(t => <span key={t}>{t}</span>)}</p>}</div>
          </article>)}</div> : <div className="empty-library"><div className="empty-cubes"><Boxes size={68} strokeWidth={1}/></div><span className="eyebrow">A PLACE FOR YOUR IDEAS</span><h2>{state.items.length ? '一致するモデルがない' : 'モデルの居場所をつくろう'}</h2><p>{state.items.length ? '検索ワードやフィルタを変えてみて。' : <>STL・STEP・3MFをここへドロップ。<br/>フォルダごと登録すれば、あとは自動で追いかける。</>}</p>{!state.items.length && <div className="empty-actions"><button className="primary-button" onClick={addFolder}><FolderPlus size={17}/>監視フォルダを追加</button><button className="secondary-button" onClick={importFiles}><Plus size={17}/>ファイルを選ぶ</button></div>}<div className="supported-formats"><span>STL</span><span>STEP / STP</span><span>3MF</span></div></div>}
        </section>
        {selected && <><section className="preview-panel"><div className="preview-heading"><div><span className={`format-badge ${selected.format}`}>{formatName(selected.format)}</span><b title={selected.name}>{selected.name}</b></div><button className="icon-button" title="プレビューを閉じる" onClick={() => setSelectedId(null)}><X size={18}/></button></div><div className="viewer-wrap"><ModelViewer key={`${selected.id}:${selected.modifiedAt}`} item={selected} memoryBudgetMiB={state.settings.memoryBudgetMiB ?? 2048} reloadToken={reloadToken} onOpenMemorySettings={() => setSettingsOpen(true)} onMetadata={setMetadata} onThumbnail={dataUrl => window.nine.saveThumbnail(selected.id,dataUrl).catch(() => {})} viewMode={viewMode} showGrid={showGrid} autoRotate={autoRotate} viewPreset={viewPreset} fitToken={fitToken}/><div className="viewer-tools"><button title="全体を表示 (F)" onClick={() => setFitToken(t => t+1)}><Scan size={18}/></button><span/><button title="ワイヤーフレーム" className={viewMode === 'wireframe' ? 'active' : ''} onClick={() => setViewMode(v => v === 'solid' ? 'wireframe' : 'solid')}><Cuboid size={18}/></button><button title="グリッド" className={showGrid ? 'active' : ''} onClick={() => setShowGrid(v => !v)}><Grid3X3 size={18}/></button><button title="自動回転" className={autoRotate ? 'active' : ''} onClick={() => setAutoRotate(v => !v)}><Rotate3D size={18}/></button></div><div className="view-presets">{[['iso','斜め'],['front','正面'],['top','上面'],['right','右面']].map(([key,label]) => <button className={viewPreset === key ? 'active' : ''} key={key} onClick={() => { setViewPreset(key); setFitToken(t => t+1); }}>{label}</button>)}</div></div><div className="viewer-footer"><span><MousePointer2 size={13}/>左ドラッグ: 回転 · 右: 移動 · ホイール: 拡大</span><span>mm</span></div></section>
        <aside className="inspector"><div className="inspector-title">モデル詳細<FileBox size={17}/></div><div className="inspector-scroll"><div className="detail-section"><label>ファイル名</label><h2>{selected.name}</h2><span className={`format-tag ${selected.format}`}>{formatName(selected.format)}</span><span className="detail-size">{formatSize(selected.size)}</span></div>
        <div className="detail-section"><label>サイズ <span>mm</span></label><div className="dimensions">{['X','Y','Z'].map((axis,i) => <div key={axis}><span className={`axis-${axis}`}>{axis}</span><b>{metadata?.dimensions?.[i]?.toFixed(2) ?? '—'}</b></div>)}</div><div className="stat-row"><span>三角形</span><b>{metadata?.triangles?.toLocaleString() ?? '—'}</b></div><div className="stat-row"><span>メッシュ</span><b>{metadata?.objects?.toLocaleString() ?? '—'}</b></div>{metadata?.warnings?.map((warning,i) => <p className="model-warning" key={i}><AlertCircle size={13}/>{warning}</p>)}</div>
        <div className="detail-section"><label>タグ<Tag size={13}/></label><form onSubmit={e => { e.preventDefault(); action(() => window.nine.updateItem(selected.id,{ tags: [...new Set(tagText.split(/[,、]/).map(t => t.trim()).filter(Boolean))] }), 'タグを保存した'); }}><input className="detail-input" aria-label="タグ" placeholder="例: 治具, プリンタ" value={tagText} onChange={e => setTagText(e.target.value)}/><button className="text-button" type="submit">保存<Check size={13}/></button></form><label className="note-label">メモ</label><textarea className="detail-input" aria-label="メモ" placeholder="素材、用途、次に直すところ…" rows={3} value={notes} onChange={e => setNotes(e.target.value)}/><button className="text-button" onClick={() => action(() => window.nine.updateItem(selected.id,{notes}), 'メモを保存した')}>保存<Check size={13}/></button></div>
        <div className="detail-section file-details"><label>保存場所</label><p title={selected.path}>{selected.path}</p><button className="text-button" onClick={() => action(() => window.nine.revealItem(selected.id))}><FolderOpen size={14}/>エクスプローラーで表示</button><div className="stat-row"><span>更新日</span><span>{date(selected.modifiedAt)}</span></div><button className="text-button remove-button" onClick={() => action(() => window.nine.removeItem(selected.id), '登録を解除した。元のファイルはそのまま。')}><Trash2 size={13}/>ライブラリから登録解除</button></div></div>
        <div className="bambu-action"><button disabled={selected.missing || busy} onClick={() => action(() => window.nine.openBambu(selected.id), 'Bambu Studioにファイルを渡した')}><Box size={19}/><span>Bambu Studioで開く</span><ArrowUpRight size={17}/></button><span>元ファイルをそのまま開く</span></div></aside></>}
      </div><footer className="app-status"><span><i className={state.status?.scanning ? 'status-dot amber' : 'status-dot'}/>{state.status?.scanning ? 'モデルをスキャン中…' : state.folders.length ? `${state.folders.length} フォルダを監視中` : '監視フォルダ未設定'}</span><span>{state.status?.message || `${state.items.length} モデル · 自動保存`}</span></footer>
    </main>
    {contextItem && <ModelContextMenu item={contextItem} anchor={contextMenu.anchor}
      disabled={modelActionDisabled} onClose={closeModelMenu} onSelect={runModelAction}/>}
    {dragging && <div className="drop-overlay"><FolderPlus size={52}/><h2>モデルをここにドロップ</h2><p>STL · STEP · 3MF</p></div>}
    {toast && <div className={`toast ${toast.error ? 'error' : ''}`} role="status">{toast.error ? <AlertCircle size={18}/> : <Check size={18}/>}<span>{toast.message}</span><button className="icon-button" onClick={() => setToast(null)}><X size={15}/></button></div>}
    {settingsOpen && <div className="modal-backdrop" onClick={() => setSettingsOpen(false)}><section className="settings-modal" role="dialog" aria-modal="true" aria-label="設定と連携" onClick={e => e.stopPropagation()}><header><div><span className="eyebrow">PREFERENCES</span><h2>設定と連携</h2></div><button className="icon-button" onClick={() => setSettingsOpen(false)} title="設定を閉じる"><X size={20}/></button></header><MemorySettings settings={state.settings} system={state.system} onSave={saveMemorySettings} hasSelection={!!selected} busy={busy}/><div className="settings-section"><h3><Box size={18}/>Bambu Studio</h3><p>ライブラリの元ファイルを、インストール済みのBambu Studioで開く。</p><div className="path-field">{state.settings.bambuPath || '未検出 — 実行ファイルを指定してね'}</div><button className="secondary-button" onClick={() => action(() => window.nine.chooseBambu())}><FolderOpen size={15}/>実行ファイルを選択</button></div><div className="settings-section"><h3><Folder size={18}/>監視フォルダ</h3><p>サブフォルダも対象。追加・変更・削除を自動で反映する。</p>{state.folders.map(folder => <div className="settings-folder" key={folder.id}><Folder size={15}/><span title={folder.path}>{folder.path}</span><button className="icon-button" title="フォルダの監視を解除" onClick={() => action(() => window.nine.removeFolder(folder.id), 'フォルダの監視を解除した')}><X size={15}/></button></div>)}<button className="secondary-button" onClick={addFolder}><FolderPlus size={15}/>監視フォルダを追加</button></div><div className="settings-section about-section"><Hexagon size={24}/><div><b>Nine Model Library <small>0.4.0</small></b><p>ファイル管理・形式アダプタ・3Dビューを分離した、拡張できるローカルライブラリ。</p></div></div></section></div>}
  </div>;
}
