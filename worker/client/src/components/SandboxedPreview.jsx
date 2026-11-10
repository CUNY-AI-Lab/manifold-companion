import { useEffect, useMemo, useState } from 'react';
import { katexStylesheetFor } from '../lib/katex-assets';
import { previewBody, wrapPreview } from '../lib/preview';

/**
 * The only way stored HTML or Markdown is displayed. `sandbox=""` grants
 * nothing: no scripts, no same-origin (an opaque origin with no access to the
 * app, its cookies or its API), no forms, no popups, no top navigation.
 * Mathematics is rendered with KaTeX here in the parent and arrives in the
 * frame as finished markup with its stylesheet and fonts inlined.
 */
export default function SandboxedPreview({ html, markdown, images, title = 'Preview', className = '' }) {
  const { body, mathCount } = useMemo(() => previewBody({ html, markdown, images }), [html, markdown, images]);
  const [doc, setDoc] = useState(() => (mathCount === 0 ? wrapPreview(body) : null));
  useEffect(() => {
    let live = true;
    if (mathCount === 0) {
      setDoc(wrapPreview(body));
      return undefined;
    }
    katexStylesheetFor(body).then(
      (css) => live && setDoc(wrapPreview(body, css)),
      // Fonts unavailable: still show the formulas, in fallback fonts.
      () => live && setDoc(wrapPreview(body)),
    );
    return () => { live = false; };
  }, [body, mathCount]);
  return (
    <iframe
      title={title}
      sandbox=""
      referrerPolicy="no-referrer"
      srcDoc={doc ?? wrapPreview('')}
      aria-busy={doc === null}
      className={`h-full min-h-[24rem] w-full rounded-md border border-slate-200 bg-white dark:border-slate-700 ${className}`}
    />
  );
}
