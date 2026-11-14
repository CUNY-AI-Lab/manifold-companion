import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { thumbnailFor } from '../lib/thumbs';

/** A page's thumbnail, made when it scrolls into view. Decorative: the row's button names the page. */
export default function PageThumb({ textId, page }) {
  const ref = useRef(null);
  const [url, setUrl] = useState(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || visible) return undefined;
    if (typeof IntersectionObserver === 'undefined') { setVisible(true); return undefined; }
    const io = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) { setVisible(true); io.disconnect(); } }, { rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, [visible]);
  useEffect(() => {
    if (!visible || !page.has_image) return undefined;
    let live = true;
    thumbnailFor(page.id, async () => (await api.raw(`/api/texts/${textId}/pages/${page.id}/image`)).blob()).then((u) => { if (live) setUrl(u); });
    return () => { live = false; };
  }, [visible, page.id, page.has_image, textId]);
  return (
    <span ref={ref} aria-hidden="true" className="flex h-12 w-9 shrink-0 items-center justify-center overflow-hidden rounded border border-slate-200 bg-slate-100 dark:border-slate-600 dark:bg-slate-700">
      {url ? <img src={url} alt="" className="h-full w-full object-cover" data-thumb={page.id} /> : null}
    </span>
  );
}
