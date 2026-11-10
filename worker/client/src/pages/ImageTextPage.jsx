import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { API, api } from '../api/client';
import { useSession } from '../api/session.jsx';
import CommentsPanel from '../components/CommentsPanel';
import MetadataPanel from '../components/MetadataPanel';
import TextSettingsPanel, { useTextSettings } from '../components/TextSettingsPanel';
import FullTextPanel from '../components/FullTextPanel';
import SandboxedPreview from '../components/SandboxedPreview';
import VersionHistory from '../components/VersionHistory';
import { ErrorNote, ModelPicker, MoveButtons, QuotaLine, useMoveFocus } from '../components/ui';
import { jpegName, prepareImage } from '../lib/image';
import { openPdf, renderPage } from '../lib/pdf';
import { runOcr, translateText } from '../lib/tasks';
import { replaceWarning } from '../lib/versions';
import { splitGroups } from '../lib/split';
import { useConfirm } from '../components/ConfirmDialog';
import useFileDrop, { DropOverlay, sortDropped } from '../hooks/useFileDrop';
import { DraftBanner, useDraftKeeper, useLeaveGuard, useStoredDraft } from '../hooks/useUnsaved';
import { useShortcut } from '../hooks/useShortcuts';
import { draftDiffers, savedChangedSince } from '../lib/drafts';

const isPdf = (file) => file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
/** What a page upload takes: an image (any the browser may open; HEIC gets its own message) or a PDF. */
export const takesAsPage = (file) => isPdf(file) || /^image\//i.test(file.type) || /\.(jpe?g|png|webp|gif|bmp|tiff?|hei[cf]|avif)$/i.test(file.name);

const LANGS = ['en', 'es', 'fr', 'de', 'it', 'pt', 'ru', 'zh', 'ja', 'ko', 'ar', 'hi', 'nl', 'pl', 'el', 'tr', 'he', 'uk', 'la'];

function SplitPanel({ text, pages }) {
  const [open, setOpen] = useState(false);
  const [spec, setSpec] = useState('');
  const [done, setDone] = useState(null);
  const [error, setError] = useState(null);
  const groups = splitGroups(spec, pages.length);
  return (
    <section aria-labelledby="split-title" className="mt-6 rounded-md border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-800">
      <h2 id="split-title" className="m-0 text-base">
        <button type="button" className="flex w-full items-center justify-between px-4 py-3 text-left" aria-expanded={open} onClick={() => setOpen((o) => !o)}><span>Split into several texts</span><span aria-hidden="true">{open ? '−' : '+'}</span></button>
      </h2>
      {open ? (
        <form className="space-y-2 border-t border-slate-200 px-4 py-3 text-sm dark:border-slate-700" onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          try {
            const { texts } = await api.post(`/api/texts/${text.id}/split`, { splits: groups.map((g, i) => ({ name: `${text.name}, part ${i + 1}`, pages: g })) });
            setDone(texts);
          } catch (err) { setError(err); }
        }}>
          <ErrorNote error={error} onDismiss={() => setError(null)} />
          <label className="block"><span className="label">New texts start at pages</span><input className="field max-w-xs" placeholder="e.g. 4, 9" value={spec} onChange={(e) => { setSpec(e.target.value); setDone(null); }} /></label>
          <p className="text-xs text-slate-600 dark:text-slate-300">{groups.length > 1 ? `Makes ${groups.length} new texts: ${groups.map((g, i) => `part ${i + 1} (pages ${g[0]}${g.length > 1 ? `–${g[g.length - 1]}` : ''})`).join(', ')}. Pages, images and text are copied; this text stays as it is.` : 'Give at least one page number after the first.'}</p>
          <button className="btn-quiet" type="submit" disabled={groups.length < 2}>Split</button>
          {done ? <p role="status">Created {done.map((t, i) => <span key={t.id}>{i ? ', ' : ''}<Link to={`/texts/${t.id}`}>{t.name}</Link></span>)}.</p> : null}
        </form>
      ) : null}
    </section>
  );
}

export default function ImageTextPage({ data, reload }) {
  const { refresh } = useSession();
  const confirm = useConfirm();
  const { text, pages, role } = data;
  const canEdit = role !== 'viewer';
  const [selected, setSelected] = useState(pages[0]?.id ?? null);
  const [draft, setDraft] = useState('');
  const [rotate, setRotate] = useState(0);
  const [model, setModel] = useState(null);
  const [settings, setSettings] = useTextSettings(text.id);
  const [run, setRun] = useState(null); // { done, total, current, failures, controller }
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [conflict, setConflict] = useState(null);
  const [translation, setTranslation] = useState(null);
  const [langs, setLangs] = useState({ source: text.source_language || 'auto-detect', target: text.target_language || 'en' });
  const fileInput = useRef(null);
  const pageText = useRef(null);
  const [moved, setMoved] = useState('');
  const focusMoved = useMoveFocus([pages]);
  // Keep a valid selection as pages arrive or are deleted.
  useEffect(() => { if (!pages.some((p) => p.id === selected)) setSelected(pages[0]?.id ?? null); }, [pages, selected]);
  const page = pages.find((p) => p.id === selected) ?? null;
  const pendingRestore = useRef(null);
  // Which page `draft` belongs to: until the effect below has loaded a page's text, nothing is unsaved.
  const [draftPage, setDraftPage] = useState(null);
  useEffect(() => {
    const restore = pendingRestore.current;
    pendingRestore.current = null;
    setDraft(restore && restore.target.pageId === page?.id ? restore.content : page?.ocr_text ?? '');
    setDraftPage(page?.id ?? null);
    setConflict(null);
  }, [page?.id, page?.ocr_text]);

  // Unsaved edits: one to a page, one to the full text. Leaving asks first; the latest is kept as this text's local draft.
  const [fullDraft, setFullDraft] = useState(null);
  const [fullRestore, setFullRestore] = useState(null);
  const pageDirty = !!page && draftPage === page.id && draft !== (page.ocr_text ?? '');
  useLeaveGuard(pageDirty || fullDraft !== null);
  const pageKeeper = useDraftKeeper({ textId: text.id, target: { kind: 'page', pageId: page?.id }, content: draft, saved: page?.ocr_text ?? '', dirty: pageDirty });
  const { draft: stored, discard } = useStoredDraft(text.id);
  const [offer, setOffer] = useState(true);
  useEffect(() => { if (pageDirty || fullDraft !== null) setOffer(false); }, [pageDirty, fullDraft]);
  const storedPage = stored?.target.kind === 'page' ? pages.find((p) => p.id === stored.target.pageId) : null;
  const showDraft = offer && stored && (stored.target.kind === 'fulltext' || (storedPage && draftDiffers(stored, storedPage.ocr_text)));
  const restoreStored = () => {
    setOffer(false);
    if (stored.target.kind === 'fulltext') { setFullRestore(stored.content); return; }
    if (selected === stored.target.pageId) setDraft(stored.content);
    else { pendingRestore.current = stored; setSelected(stored.target.pageId); }
  };
  const selectPage = async (id) => {
    if (id === selected) return;
    if (pageDirty && !(await confirm({ title: 'Discard the changes to this page?', message: `Page ${page.page_number} has changes that are not saved. Open another page and discard them?`, confirmLabel: 'Discard and open', cancelLabel: 'Stay on this page', danger: true }))) return;
    if (pageDirty) pageKeeper.forget();
    setSelected(id);
  };
  useEffect(() => { api.get(`/api/texts/${text.id}/translation`).then((r) => setTranslation(r.translation), () => {}); }, [text.id]);

  const upload = async (files) => {
    setError(null);
    for (const file of files) {
      try {
        if (isPdf(file)) {
          const pdf = await openPdf(file);
          for (let n = 1; n <= pdf.numPages; n += 1) {
            setBusy(`Rasterising ${file.name}, page ${n} of ${pdf.numPages}`);
            const { blob } = await renderPage(pdf, n);
            await api.upload(`/api/texts/${text.id}/pages`, blob, { filename: `${file.name.replace(/\.pdf$/i, '')}-p${String(n).padStart(3, '0')}.jpg` });
          }
        } else {
          setBusy(`Preparing ${file.name}`);
          const { blob } = await prepareImage(file, { rotate });
          await api.upload(`/api/texts/${text.id}/pages`, blob, { filename: jpegName(file.name) });
        }
      } catch (e) { setError(e); break; }
    }
    setBusy(null);
    reload();
    refresh();
  };

  const dragging = useFileDrop({
    enabled: canEdit && !busy && !run,
    onDrop: (files) => {
      const { taken, refused } = sortDropped(files, takesAsPage);
      if (taken.length) upload(taken).then(() => { if (refused.length) setError({ message: `Not uploaded, not an image or a PDF: ${refused.join(', ')}.` }); });
      else setError({ message: `Not uploaded, not an image or a PDF: ${refused.join(', ')}.` });
    },
  });

  const startOcr = async (overwrite) => {
    const targets = overwrite ? pages : pages.filter((p) => !p.ocr_text);
    if (targets.length === 0) return;
    if (overwrite && targets.some((p) => p.ocr_text) && !(await confirm({ title: 'Read every page again?', message: replaceWarning('Read every page again with the model? This replaces the text of every page.').replace('The current text', 'The current text of each page'), confirmLabel: 'Read every page again' }))) return;
    const controller = new AbortController();
    setRun({ done: 0, total: targets.length, current: targets[0].filename, failures: [], controller });
    setError(null);
    const outcomes = await runOcr({
      textId: text.id, pages: targets, overwrite, model, signal: controller.signal,
      onPage: ({ index, page: p, state }) => setRun((r) => r && ({ ...r, current: p.filename, done: state === 'running' ? index : index + 1 })),
    });
    const failures = outcomes.filter((o) => !o.ok);
    setRun(null);
    if (failures.length) setError({ message: `${failures.length} page(s) not read. ${failures[0].error.message}`, retryAfter: failures[0].error.retryAfter, requestId: failures[0].error.requestId });
    reload();
  };

  const movePage = async (index, dir) => {
    const p = pages[index];
    setError(null);
    try {
      const r = await api.post(`/api/texts/${text.id}/pages/${p.id}/move`, { to: index + 1 + (dir === 'up' ? -1 : 1) });
      setMoved(`${p.filename} moved to position ${r.position} of ${r.total}.`);
      focusMoved({ idBase: `move-page-${p.id}`, dir });
      reload();
    } catch (e) { setError(e); }
  };

  const savePage = async () => {
    try {
      await api.post(`/api/texts/${text.id}/pages/${page.id}`, { text: draft });
      reload();
      return true;
    } catch (e) { setError(e); return false; }
  };
  const inFullText = () => !!document.activeElement?.closest?.('[data-editor="fulltext"]');
  const pageIndex = pages.findIndex((p) => p.id === selected);
  useShortcut('save', () => { if (!inFullText() && pageDirty) savePage(); }, canEdit && !!page);
  useShortcut('save-next', async () => {
    if (inFullText()) return;
    if (pageDirty && !(await savePage())) return;
    const next = pages[pageIndex + 1];
    if (next) setSelected(next.id);
  }, canEdit && !!page);
  useShortcut('next-page', () => { const next = pages[pageIndex + 1]; if (next) selectPage(next.id); }, pages.length > 1);
  useShortcut('prev-page', () => { const prev = pages[pageIndex - 1]; if (prev) selectPage(prev.id); }, pages.length > 1);

  const ocrOne = async () => {
    if (page.ocr_text && !(await confirm({ title: 'Read this page again?', message: replaceWarning(`Read page ${page.page_number} again with the model?${draft !== page.ocr_text ? ' Your unsaved changes to this page will be lost.' : ''}`), confirmLabel: 'Read again' }))) return;
    setBusy('Reading this page');
    setConflict(null);
    try {
      await api.post(`/api/texts/${text.id}/pages/${page.id}/ocr`, { overwrite: true, ...(model ? { model } : {}) });
      reload();
    } catch (e) {
      if (e.code === 'edit_conflict') setConflict(e.result?.text ?? null);
      setError(e);
    } finally { setBusy(null); }
  };

  return (
    <div>
      <DropOverlay show={dragging} label={`Drop to add pages to “${text.name}”`} />
      <p className="text-sm"><Link to={`/projects/${text.project_id}`}>Back to project</Link></p>
      <h1 className="doc-title mt-1 text-3xl">{text.name}</h1>
      <p className="text-xs text-slate-500 dark:text-slate-400">{pages.length} pages, {text.status}</p>
      {showDraft ? <DraftBanner what={stored.target.kind === 'fulltext' ? 'the full text' : `page ${storedPage.page_number} (${storedPage.filename})`} at={stored.at} savedChanged={stored.target.kind === 'page' && savedChangedSince(stored, storedPage.ocr_text)} onRestore={restoreStored} onDiscard={() => { discard(); setOffer(false); }} /> : null}
      <ErrorNote error={error} onDismiss={() => setError(null)} />
      {busy ? <p role="status" className="text-sm text-cail-azure dark:text-cail-link-dark">{busy}</p> : null}

      {canEdit ? (
        <section className="mt-4 flex flex-wrap items-center gap-3 rounded-md border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-800">
          <input ref={fileInput} type="file" multiple accept="image/*,.heic,.heif,application/pdf" className="hidden" onChange={(e) => { upload([...e.target.files]); e.target.value = ''; }} />
          <button className="btn-quiet" type="button" onClick={() => fileInput.current?.click()} disabled={!!busy || !!run}>Upload pages</button>
          <span className="text-xs text-slate-600 dark:text-slate-300">or drop images or a PDF anywhere on this page</span>
          <label className="text-sm">Rotate uploads <select className="field inline-block w-auto" value={rotate} onChange={(e) => setRotate(Number(e.target.value))}>{[0, 90, 180, 270].map((d) => <option key={d} value={d}>{d}°</option>)}</select></label>
          <ModelPicker task="ocr" value={model} onChange={setModel} label="OCR model" savedDefault={settings?.model ?? null} />
          {run ? (
            <span className="flex items-center gap-3 text-sm"><span role="status">Reading {run.current} ({run.done} of {run.total})</span><button className="btn-danger" type="button" onClick={() => run.controller.abort()}>Cancel</button></span>
          ) : (
            <>
              <button className="btn-primary" type="button" disabled={!pages.some((p) => !p.ocr_text) || !!busy} onClick={() => startOcr(false)}>Read pages without text</button>
              <button className="btn-quiet" type="button" disabled={pages.length === 0 || !!busy} onClick={() => startOcr(true)}>Read all pages again</button>
            </>
          )}
          <div className="w-full"><QuotaLine /></div>
        </section>
      ) : null}

      <div className="mt-4 grid gap-4 md:grid-cols-[12rem_1fr]">
        <nav aria-label="Pages">
          <ol className="space-y-1 text-sm">
            {pages.map((p, i) => (
              <li key={p.id} className="flex items-center gap-1">
                <button type="button" aria-current={p.id === selected ? 'true' : undefined} className={`min-w-0 flex-1 truncate rounded px-2 py-1 text-left ${p.id === selected ? 'bg-cail-blue/10 font-medium' : ''}`} onClick={() => selectPage(p.id)}>{p.page_number}. {p.filename}{p.ocr_text ? '' : ' (no text)'}</button>
                {canEdit && pages.length > 1 ? <MoveButtons label={`page ${p.page_number} (${p.filename})`} index={i} total={pages.length} idBase={`move-page-${p.id}`} disabled={!!run} onMove={movePage} /> : null}
              </li>
            ))}
          </ol>
          <p className="sr-only" role="status">{moved}</p>
          {canEdit && pages.length > 1 ? <p className="mt-2 text-xs text-slate-600 dark:text-slate-300">The order here is the order of the export.</p> : null}
        </nav>
        {page ? (
          <div className="grid gap-4 lg:grid-cols-2">
            <img src={`${API}/texts/${text.id}/pages/${page.id}/image`} alt={`Scan of page ${page.page_number}`} className="max-h-[70vh] w-full rounded-md border border-slate-200 object-contain dark:border-slate-700" />
            <div className="flex flex-col gap-2">
              <label className="label" htmlFor="page-text">Text of page {page.page_number}{page.ocr_model ? `, read by ${page.ocr_model}` : ''}</label>
              <textarea ref={pageText} id="page-text" className="field min-h-[18rem] font-mono" value={draft} readOnly={!canEdit} onChange={(e) => setDraft(e.target.value)} />
              {conflict ? <details className="text-sm"><summary>Model text that was not saved (the page was edited meanwhile)</summary><pre className="whitespace-pre-wrap">{conflict}</pre><button type="button" className="btn-quiet mt-1" onClick={() => setDraft(conflict)}>Use the model text</button></details> : null}
              {canEdit ? (
                <div className="flex flex-wrap gap-2">
                  <button className="btn-primary" type="button" onClick={savePage} disabled={draft === (page.ocr_text ?? '')}>Save page</button>
                  <button className="btn-quiet" type="button" onClick={ocrOne} disabled={!!busy || !!run}>Read this page again</button>
                  <button className="btn-danger" type="button" onClick={async () => { if (!(await confirm({ title: 'Delete this page?', message: `Delete page ${page.page_number} (${page.filename}), its image and its saved versions? This cannot be undone.`, confirmLabel: 'Delete page', danger: true }))) return; await api.del(`/api/texts/${text.id}/pages/${page.id}`); reload(); refresh(); }}>Delete page</button>
                </div>
              ) : null}
              <SandboxedPreview markdown={draft} title={`Preview of page ${page.page_number}`} className="min-h-[14rem]" />
              <VersionHistory key={page.id} textId={text.id} type="page" pageId={page.id} canRestore={canEdit} refreshKey={page.ocr_text} dirty={draft !== (page.ocr_text ?? '')} onRestored={reload} />
            </div>
          </div>
        ) : <p className="text-sm text-slate-500 dark:text-slate-400">No pages yet.{canEdit ? ' Upload photos, scans or a PDF; PDFs are turned into page images in your browser.' : ''}</p>}
      </div>

      <section className="mt-8 grid gap-6 lg:grid-cols-2">
        <div>
          <h2 className="text-lg">Summary</h2>
          <p className="mt-1 whitespace-pre-wrap text-sm">{text.summary || 'No summary yet.'}</p>
          {canEdit ? <button className="btn-quiet mt-2" type="button" disabled={!!busy} onClick={async () => { setBusy('Writing a summary'); try { await api.post(`/api/texts/${text.id}/summary`, {}); reload(); } catch (e) { setError(e); } finally { setBusy(null); } }}>Write a summary</button> : null}
        </div>
        <div>
          <h2 className="text-lg">Translation</h2>
          {canEdit ? (
            <div className="mt-1 flex flex-wrap items-center gap-2 text-sm">
              <label>From <select className="field inline-block w-auto" value={langs.source} onChange={(e) => setLangs({ ...langs, source: e.target.value })}><option value="auto-detect">detect</option>{LANGS.map((l) => <option key={l}>{l}</option>)}</select></label>
              <label>to <select className="field inline-block w-auto" value={langs.target} onChange={(e) => setLangs({ ...langs, target: e.target.value })}>{LANGS.map((l) => <option key={l}>{l}</option>)}</select></label>
              <button className="btn-quiet" type="button" disabled={!!busy} onClick={async () => {
                const source = pages.filter((p) => p.ocr_text).map((p) => p.ocr_text).join('\n\n---\n\n');
                if (!source) return;
                try { setTranslation(await translateText({ textId: text.id, text: source, source: langs.source, target: langs.target, onProgress: ({ done, total }) => setBusy(`Translating part ${Math.min(done + 1, total)} of ${total}`) })); } catch (e) { setError(e); } finally { setBusy(null); }
              }}>Translate</button>
            </div>
          ) : null}
          {translation ? <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap font-doc text-sm">{translation}</pre> : <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">No translation yet.</p>}
        </div>
      </section>
      <FullTextPanel textId={text.id} canEdit={canEdit} pagesKey={pages.map((p) => `${p.id}:${p.ocr_text?.length ?? 0}`).join(',')} onDraftChange={setFullDraft} restoreDraft={fullRestore} onRestoreTaken={() => setFullRestore(null)} />
      {canEdit && pages.length > 1 ? <SplitPanel text={text} pages={pages} /> : null}
      <TextSettingsPanel textId={text.id} kind="image" canEdit={canEdit} settings={settings} onSaved={setSettings} />
      <MetadataPanel textId={text.id} canEdit={canEdit} />
      <CommentsPanel textId={text.id} canWrite={canEdit} source={page ? { text: draft, pageId: page.id, textareaRef: pageText } : null} pages={pages} onGoToPage={setSelected} />
    </div>
  );
}
