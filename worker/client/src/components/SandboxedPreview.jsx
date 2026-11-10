import { previewDocument } from '../lib/preview';

/**
 * The only way stored HTML or Markdown is displayed. `sandbox=""` grants
 * nothing: no scripts, no same-origin (an opaque origin with no access to the
 * app, its cookies or its API), no forms, no popups, no top navigation.
 */
export default function SandboxedPreview({ html, markdown, images, title = 'Preview', className = '' }) {
  return (
    <iframe
      title={title}
      sandbox=""
      referrerPolicy="no-referrer"
      srcDoc={previewDocument({ html, markdown, images })}
      className={`h-full min-h-[24rem] w-full rounded-md border border-slate-200 bg-white dark:border-slate-700 ${className}`}
    />
  );
}
