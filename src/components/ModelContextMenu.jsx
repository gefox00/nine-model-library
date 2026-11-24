import { useEffect, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Box, Copy, Eye, ImagePlus, Trash2 } from 'lucide-react';
import './ModelContextMenu.css';

const actions = [
  { id: 'preview', label: 'プレビュー', Icon: Eye },
  { id: 'thumbnail', label: 'サムネイル生成', Icon: ImagePlus },
  { id: 'copy', label: '指定先へコピー', Icon: Copy },
  { id: 'bambu', label: 'バンブースタジオで開く', Icon: Box },
  { id: 'trash', label: '削除', Icon: Trash2 },
];

export default function ModelContextMenu({ item, anchor, disabled, onClose, onSelect }) {
  const menuRef = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useLayoutEffect(() => {
    const menu = menuRef.current;
    const margin = 8;
    const { width, height } = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(margin, Math.min(anchor.x, window.innerWidth - width - margin))}px`;
    menu.style.top = `${Math.max(margin, Math.min(anchor.y, window.innerHeight - height - margin))}px`;
    menu.querySelector('[role="menuitem"]').focus({ preventScroll: true });
  }, [anchor]);

  useEffect(() => {
    const dismiss = () => closeRef.current();
    const outside = event => {
      if (!menuRef.current?.contains(event.target)) dismiss();
    };
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', dismiss);
    window.addEventListener('blur', dismiss);
    window.addEventListener('scroll', outside, true);
    return () => {
      window.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('blur', dismiss);
      window.removeEventListener('scroll', outside, true);
    };
  }, []);

  function onKeyDown(event) {
    if (event.key === 'Escape' || event.key === 'Tab') {
      if (event.key === 'Escape') event.preventDefault();
      event.stopPropagation();
      onClose(true);
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const entries = [...menuRef.current.querySelectorAll('[role="menuitem"]')];
    const index = entries.indexOf(document.activeElement);
    const last = entries.length - 1;
    if (event.key === 'Home') entries[0].focus();
    else if (event.key === 'End') entries[last].focus();
    else if (event.key === 'ArrowDown') entries[index === last ? 0 : index + 1].focus();
    else entries[index <= 0 ? last : index - 1].focus();
  }

  return createPortal(
    <div ref={menuRef} className="model-context-menu" role="menu"
      aria-label={`${item.name} の操作`} onKeyDown={onKeyDown} onContextMenu={event => event.preventDefault()}>
      <div className="model-context-name" title={item.name} aria-hidden="true">{item.name}</div>
      {actions.map(({ id, label, Icon }) => (
        <button key={id} type="button" role="menuitem" tabIndex={-1} aria-disabled={disabled(id)}
          className={id === 'trash' ? 'model-context-delete' : undefined}
          onClick={() => { if (!disabled(id)) onSelect(id); }}>
          <Icon size={16} aria-hidden="true" />{label}
        </button>
      ))}
    </div>, document.body
  );
}
