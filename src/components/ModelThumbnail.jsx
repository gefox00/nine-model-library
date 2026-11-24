import { useEffect, useRef, useState } from 'react';
import { Cuboid } from 'lucide-react';

export default function ModelThumbnail({ item, size = 64 }) {
  const anchor = useRef(null);
  const [image, setImage] = useState(null);
  const { id, hasThumbnail, thumbnailRevision } = item;

  useEffect(() => {
    if (!hasThumbnail) return;
    let active = true;
    const load = () => {
      window.nine.getThumbnail(id, thumbnailRevision).then(source => {
        if (active && source) setImage({ id, revision: thumbnailRevision, source });
      }).catch(() => {});
    };
    if (!anchor.current || typeof IntersectionObserver === 'undefined') {
      load();
      return () => { active = false; };
    }
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      observer.disconnect();
      load();
    });
    observer.observe(anchor.current);
    return () => { active = false; observer.disconnect(); };
  }, [id, hasThumbnail, thumbnailRevision]);

  const source = hasThumbnail && image?.id === id && image.revision === thumbnailRevision ? image.source : null;
  return <div className="model-thumbnail" ref={anchor}>
    {source ? <img src={source} alt="" decoding="async"/>
      : <div className="model-placeholder"><Cuboid strokeWidth={1} size={size}/></div>}
  </div>;
}
