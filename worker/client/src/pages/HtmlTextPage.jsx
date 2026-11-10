import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { sanitizeHtml } from '../../../src/sanitize/html.ts';
import { API, api } from '../api/client';
import { brokenFormulas as brokenTex } from '../lib/math';
import { useSession } from '../api/session.jsx';
import CommentsPanel from '../components/CommentsPanel';
import MetadataPanel from '../components/MetadataPanel';
import SandboxedPreview from '../components/SandboxedPreview';
import VersionHistory from '../components/VersionHistory';
import { ErrorNote, ModelPicker, QuotaLine } from '../components/ui';
import { blobToDataUri, prepareImage } from '../lib/image';
import { checkList, convertPdf } from '../lib/tasks';
import { replaceWarning } from '../lib/versions';

/** "1, 3-5" -> Set {1,3,4,5} */
export function parsePages(spec) {
  const out = new Set();
  for (const part of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(part);
    if (!m) continue;
    const a = Number(m[1]);
    const b = Number(m[2] ?? m[1]);
    for (let n = Math.min(a, b); n <= Math.max(a, b) && n - a < 2000; n += 1) out.add(n);
  }
  return out;
}

/** TeX fragments KaTeX (the on-screen renderer) cannot parse, found as legacy auto-render finds them. */
const brokenFormulas = (html) => brokenTex(sanitizeHtml(html));

export default function HtmlTextPage({ data, reload }) {
  const { refresh } = useSession();
  const { text, role } = data;
  const canEdit = role !== 'viewer';
  const [html, setHtml] = useState(null);
  const [saved, setSaved] = useState('');
  const [figures, setFigures] = useState([]);
  const [images, setImages] = useState({});
  const [file, setFile] = useState(null);
  const [mathSpec, setMathSpec] = useState('');
  const [allMath, setAllMath] = useState(false);
  const [model, setModel] = useState(null);
  const [mathModel, setMathModel] = useState(null);
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState(null);
  const controller = useRef(null);
  const done = useRef(new Map());
  const pageWarnings = useRef(new Map());
  const [checks, setChecks] = useState([]);
  const [versionKey, setVersionKey] = useState(0);
  const figureInput = useRef(null);

  const loadHtml = () => api.get(`/api/texts/${text.id}/html`).then((r) => { setHtml(r.html_content); setSaved(r.html_content); }, setError);
  const loadFigures = async () => {
    const { figures: list } = await api.get(`/api/texts/${text.id}/figures`);
    setFigures(list);
    // Previews run in an opaque-origin sandbox that cannot fetch app URLs, so figures are inlined as data: URIs.
    const entries = await Promise.all(list.map(async (f) => [f.filename, await blobToDataUri(await (await api.raw(`/api/texts/${text.id}/figures/${f.id}`)).blob())]));
    setImages(Object.fromEntries(entries));
  };
  useEffect(() => { loadHtml(); loadFigures().catch(setError); }, [text.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const convert = async () => {
    if (!file) return;
    if (saved && done.current.size === 0 && !window.confirm(replaceWarning('Convert this PDF and replace the current HTML?'))) return;
    controller.current = new AbortController();
    setError(null);
    try {
      if (!data.text.has_source_pdf || window.confirm('Replace the stored source PDF with this file?')) {
        await api.upload(`/api/texts/${text.id}/source-pdf`, file, { method: 'PUT', filename: file.name, query: { replace: '1' } });
      }
      const r = await convertPdf({ textId: text.id, file, mathPages: parsePages(mathSpec), allMath, model, mathModel, signal: controller.current.signal, done: done.current, warnings: pageWarnings.current, onProgress: setProgress });
      setChecks(checkList(r.warnings));
      setVersionKey((k) => k + 1);
      done.current = new Map();
      pageWarnings.current = new Map();
      setHtml(r.html);
      setSaved(r.html);
      reload();
      refresh();
    } catch (e) {
      if (e.name !== 'AbortError') setError({ ...e, message: `${e.message} Pages converted so far are kept; start again to continue from page ${done.current.size + 1}.` });
    } finally { setProgress(null); }
  };

  const save = async () => {
    try {
      const r = await api.put(`/api/texts/${text.id}/html`, { html_content: html });
      if (r.sanitized) await loadHtml();
      else setSaved(html);
      setVersionKey((k) => k + 1);
    } catch (e) { setError(e); }
  };

  const repair = async () => {
    const broken = brokenFormulas(html ?? '');
    if (broken.length === 0) { setError({ message: 'Every formula renders; nothing to repair.' }); return; }
    try {
      const { formulas } = await api.post(`/api/texts/${text.id}/formula-repair`, { formulas: broken });
      let next = html;
      for (const f of formulas) next = next.split(f.original).join(f.repaired);
      setHtml(next);
    } catch (e) { setError(e); }
  };

  return (
    <div>
      <p className="text-sm"><Link to={`/projects/${text.project_id}`}>Back to project</Link></p>
      <h1 className="doc-title mt-1 text-3xl">{text.name}</h1>
      <ErrorNote error={error} onDismiss={() => setError(null)} />
      {checks.length ? (
        <section aria-labelledby="checks-title" className="my-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
          <h2 id="checks-title" className="text-sm font-semibold">Check these by eye</h2>
          <ul className="mt-1 list-disc pl-5">{checks.map((c) => <li key={c}>{c}</li>)}</ul>
          <button type="button" className="mt-1 underline" onClick={() => setChecks([])}>Dismiss</button>
        </section>
      ) : null}
      {canEdit ? (
        <section className="mt-4 space-y-3 rounded-md border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-800">
          <h2 className="text-base">Convert a PDF</h2>
          <p className="text-sm text-slate-600 dark:text-slate-300">Each page is drawn as an image in your browser and converted one page at a time. Mark pages with mathematics or complex tables to send them to the stronger math model.</p>
          <input type="file" accept="application/pdf" aria-label="PDF file" onChange={(e) => { setFile(e.target.files[0] ?? null); done.current = new Map(); pageWarnings.current = new Map(); }} />
          <div className="flex flex-wrap items-center gap-4 text-sm">
            <label><input type="checkbox" checked={allMath} onChange={(e) => setAllMath(e.target.checked)} /> Every page has math or tables</label>
            {!allMath ? <label>Math or table pages <input className="field inline-block w-40" placeholder="e.g. 2, 5-9" value={mathSpec} onChange={(e) => setMathSpec(e.target.value)} /></label> : null}
          </div>
          <div className="flex flex-wrap gap-4">
            <ModelPicker task="html_page" value={model} onChange={setModel} label="Page model" />
            <ModelPicker task="html_math" value={mathModel} onChange={setMathModel} label="Math and tables model" />
          </div>
          {progress ? (
            <p className="flex items-center gap-3 text-sm" role="status">{progress.stage === 'assemble' ? 'Assembling the document' : `${progress.stage === 'render' ? 'Drawing' : 'Converting'} page ${progress.page} of ${progress.total}${progress.math ? ' with the math model' : ''}`}<button className="btn-danger" type="button" onClick={() => controller.current?.abort()}>Cancel</button></p>
          ) : <button className="btn-primary" type="button" disabled={!file} onClick={convert}>{done.current.size ? 'Continue converting' : 'Convert PDF'}</button>}
          <QuotaLine />
        </section>
      ) : null}

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <div className="flex flex-col gap-2">
          <label className="label" htmlFor="html-source">HTML (sanitized when saved). Write formulas as TeX in \( \) or \[ \]: the preview renders them with KaTeX, and the export converts them to MathML.</label>
          <textarea id="html-source" className="field min-h-[28rem] font-mono text-xs" value={html ?? ''} readOnly={!canEdit} onChange={(e) => setHtml(e.target.value)} />
          {canEdit ? (
            <div className="flex flex-wrap gap-2">
              <button className="btn-primary" type="button" onClick={save} disabled={html === saved}>Save HTML</button>
              <button className="btn-quiet" type="button" onClick={repair} disabled={!html}>Repair broken formulas</button>
              <input ref={figureInput} type="file" accept="image/*" className="hidden" onChange={async (e) => {
                const f = e.target.files[0]; e.target.value = '';
                if (!f) return;
                try { const { blob, width, height } = await prepareImage(f); await api.upload(`/api/texts/${text.id}/figures`, blob, { filename: f.name.replace(/\.[^.]+$/, '') + '.jpg', query: { width: String(width), height: String(height) } }); await loadFigures(); refresh(); } catch (err) { setError(err); }
              }} />
              <button className="btn-quiet" type="button" onClick={() => figureInput.current?.click()}>Add a figure image</button>
            </div>
          ) : null}
          {figures.length ? <p className="text-xs text-slate-500 dark:text-slate-400">Figures (reference with &lt;img src="name"&gt;): {figures.map((f) => f.filename).join(', ')}</p> : null}
          {data.text.has_source_pdf ? <a className="text-sm" href={`${API}/texts/${text.id}/source-pdf`}>Download the source PDF</a> : null}
        </div>
        <SandboxedPreview html={html ?? ''} images={images} title="Preview of the HTML" className="min-h-[28rem]" />
      </div>
      <VersionHistory textId={text.id} type="html" canRestore={canEdit} refreshKey={versionKey} images={images} dirty={html !== saved} onRestored={() => { loadHtml(); refresh(); }} />
      <MetadataPanel textId={text.id} canEdit={canEdit} />
      <CommentsPanel textId={text.id} canWrite={canEdit} />
    </div>
  );
}
