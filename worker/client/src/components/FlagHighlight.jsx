import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { FLAG_KINDS, findFlags } from '../lib/flags';

/**
 * A layer behind the page textarea that tints each flag ([unclear: …] etc.).
 * It repeats the text as React text nodes (never markup) in transparent ink,
 * with the same box, font and wrapping as the textarea, and follows its
 * scrolling; the textarea above stays the only thing read, typed or selected.
 */
export default function FlagHighlight({ value, textareaRef }) {
  const layer = useRef(null);
  const [box, setBox] = useState({ width: 0, scroll: 0 });
  const flags = findFlags(value);
  useLayoutEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return undefined;
    const measure = () => setBox({ width: ta.clientWidth, scroll: ta.scrollTop });
    measure();
    const onScroll = () => setBox((b) => ({ ...b, scroll: ta.scrollTop }));
    ta.addEventListener('scroll', onScroll);
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    ro?.observe(ta);
    return () => { ta.removeEventListener('scroll', onScroll); ro?.disconnect(); };
  }, [textareaRef, flags.length > 0]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (layer.current) layer.current.scrollTop = box.scroll; }, [box.scroll, value]);
  if (flags.length === 0) return null;
  const parts = [];
  let at = 0;
  for (const f of flags) {
    if (f.start > at) parts.push(value.slice(at, f.start));
    parts.push(<mark key={f.start} data-flag={f.kind} className={`rounded-sm text-transparent ${FLAG_KINDS[f.kind].doubt ? 'bg-amber-200 dark:bg-amber-700/70' : 'bg-sky-200 dark:bg-sky-800/70'}`}>{value.slice(f.start, f.end)}</mark>);
    at = f.end;
  }
  parts.push(value.slice(at));
  return (
    <div
      ref={layer}
      aria-hidden="true"
      data-flag-layer=""
      className="pointer-events-none absolute left-0 top-0 h-full overflow-hidden whitespace-pre-wrap break-words rounded-md border border-transparent px-3 py-1.5 font-mono text-sm text-transparent"
      style={{ width: box.width ? box.width + 2 : '100%' }}
    >
      {parts}
      {'\n'}
    </div>
  );
}
