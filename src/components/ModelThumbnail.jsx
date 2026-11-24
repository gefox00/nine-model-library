import { useEffect, useRef, useState } from 'react';
import { Cuboid } from 'lucide-react';

export default function ModelThumbnail({ item, size = 64 }) {
  const anchor = useRef(null);
  const [visible, setVisible] = useState(false);
  const [failedSource, setFailedSource] = useState(null);
  const { id, hasThumbnail, thumbnailRevision } = item;

  useEffect(() => {
    if (visible || !hasThumbnail) return;
    if (!anchor.current || typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      observer.disconnect();
      setVisible(true);
    });
    observer.observe(anchor.current);
    return () => observer.disconnect();
  }, [visible, hasThumbnail]);

  const source = visible && hasThumbnail && thumbnailRevision
    ? `nine-thumb://library/${encodeURIComponent(id)}/${encodeURIComponent(thumbnailRevision)}` : null;
  return <div className="model-thumbnail" ref={anchor}>
    {source && source !== failedSource ? <img src={source} alt="" decoding="async" onError={() => setFailedSource(source)}/>
      : <div className="model-placeholder"><Cuboid strokeWidth={1} size={size}/></div>}
  </div>;
}
