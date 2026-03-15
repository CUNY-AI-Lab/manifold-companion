import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, BASE } from '../api/client';
import { convertPdfToHtmlWithBedrock } from '../lib/pdfBedrockPipeline';
import SharePanel from '../components/SharePanel';
import Skeleton from '../components/Skeleton';
import Pagination from '../components/Pagination';

const TEXTS_PAGE_LIMIT = 20;

export default function PdfProjectView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const fileInputRef = useRef(null);
  const [searchParams, setSearchParams] = useSearchParams();

  const [project, setProject] = useState(null);
  const [texts, setTexts] = useState([]);
  const [totalTexts, setTotalTexts] = useState(0);
  const [textsPageSize, setTextsPageSize] = useState(TEXTS_PAGE_LIMIT);
  const [textsPage, setTextsPage] = useState(() => Math.max(1, Number(searchParams.get('page')) || 1));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');

  // Inline editing
  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState('');

  // Share panel
  const [showShare, setShowShare] = useState(false);

  // New text form
  const [showAddSection, setShowAddSection] = useState(false);
  const [newTextName, setNewTextName] = useState('');
  const [creatingText, setCreatingText] = useState(false);

  // Upload state
  const [selectedTextId, setSelectedTextId] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState('');

  // Full-page drop overlay
  const [pageDropActive, setPageDropActive] = useState(false);
  const dropCountRef = useRef(0);

  // Edit mode + drag-and-drop reorder
  const [editMode, setEditMode] = useState(false);
  const [dragIdx, setDragIdx] = useState(null);
  const [dragOverIdx, setDragOverIdx] = useState(null);

  // Export modal + TOC builder
  const [showExport, setShowExport] = useState(false);
  const [tocItems, setTocItems] = useState([]);
  const [exportMeta, setExportMeta] = useState({
    title: '', creators: '', date: '', language: 'en', rights: '', description: ''
  });
  const [exporting, setExporting] = useState(false);
  const [newSectionLabel, setNewSectionLabel] = useState('');

  // Sync textsPage to URL
  useEffect(() => {
    const params = textsPage > 1 ? { page: String(textsPage) } : {};
    setSearchParams(params, { replace: true });
  }, [textsPage]);

  useEffect(() => {
    loadProject();
  }, [id, textsPage]);

  async function loadProject() {
    try {
      const data = await api.get(`/api/projects/${id}?page=${textsPage}&limit=${TEXTS_PAGE_LIMIT}`);
      setProject(data);
      setTexts(data.texts || []);
      setTotalTexts(data.totalTexts ?? (data.texts || []).length);
      setTextsPageSize(data.pageSize ?? TEXTS_PAGE_LIMIT);
      setNameValue(data.name);
      if (!selectedTextId && data.texts?.length) {
        setSelectedTextId(String(data.texts[0].id));
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  function handleTextsPageChange(newPage) {
    setTextsPage(newPage);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function saveName() {
    if (!nameValue.trim()) return;
    try {
      await api.put(`/api/projects/${id}`, { name: nameValue.trim() });
      setProject((p) => ({ ...p, name: nameValue.trim() }));
      setEditingName(false);
    } catch (err) {
      setError(err.message);
    }
  }

  async function createText(e) {
    e.preventDefault();
    if (!newTextName.trim()) return;
    setCreatingText(true);
    setError('');
    try {
      const text = await api.post(`/api/projects/${id}/texts`, { name: newTextName.trim() });
      setNewTextName('');
      setShowAddSection(false);
      setSelectedTextId(String(text.id));
      await loadProject();
    } catch (err) {
      setError(err.message);
    } finally {
      setCreatingText(false);
    }
  }

  async function deleteText(textId) {
    if (!window.confirm('Delete this text and its source PDF?')) return;
    try {
      await api.del(`/api/texts/${textId}`);
      if (selectedTextId === String(textId)) {
        const remaining = texts.filter((t) => t.id !== textId);
        setSelectedTextId(remaining[0] ? String(remaining[0].id) : '');
      }
      await loadProject();
    } catch (err) {
      setError(err.message);
    }
  }

  async function deleteProject() {
    if (!window.confirm('Delete this entire project? This cannot be undone.')) return;
    try {
      await api.del(`/api/projects/${id}`);
      navigate('/');
    } catch (err) {
      setError(err.message);
    }
  }

  // Drag-and-drop reorder
  function handleDragStart(e, index) {
    setDragIdx(index);
    e.dataTransfer.effectAllowed = 'move';
  }

  function handleDragOver(e, index) {
    e.preventDefault();
    setDragOverIdx(index);
  }

  function handleDragEnd() {
    setDragIdx(null);
    setDragOverIdx(null);
  }

  async function handleReorderDrop(e, toIndex) {
    e.preventDefault();
    const fromIndex = dragIdx;
    setDragIdx(null);
    setDragOverIdx(null);
    if (fromIndex == null || fromIndex === toIndex) return;
    const reordered = [...texts];
    const [moved] = reordered.splice(fromIndex, 1);
    reordered.splice(toIndex, 0, moved);
    setTexts(reordered);
    try {
      await api.put(`/api/projects/${id}/texts/reorder`, { textIds: reordered.map((t) => t.id) });
    } catch (err) {
      setError(err.message);
      await loadProject();
    }
  }

  // PDF upload — called by file input and drop handler
  const handlePdfUpload = useCallback(async (file) => {
    setUploading(true);
    setError('');
    try {
      const payload = await convertPdfToHtmlWithBedrock(selectedTextId, file, (progress) => {
        if (progress.stage === 'render') {
          setUploadProgress(`Extracting page ${progress.pageNumber}/${progress.totalPages}...`);
        } else if (progress.stage === 'parse') {
          setUploadProgress(`Parsing page ${progress.pageNumber}/${progress.totalPages} (Gemini Flash, native PDF)...`);
        } else if (progress.stage === 'cleanup') {
          setUploadProgress('Normalizing headings and merging fragments...');
        }
      });

      setUploadProgress('Uploading source PDF and generated HTML...');
      const formData = new FormData();
      formData.append('pdf', file);
      formData.append('html_content', payload.html);
      formData.append('pdf_meta', JSON.stringify(payload.meta));
      formData.append('formula_repair_status', payload.formulaStatus);

      await api.upload(`/api/texts/${selectedTextId}/pdf-upload`, formData);
      setToast(`Imported ${file.name}`);
      setTimeout(() => setToast(''), 3000);
      await loadProject();
      navigate(`/texts/${selectedTextId}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
      setUploadProgress('');
    }
  }, [selectedTextId, navigate]);

  async function handlePdfSelect(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!selectedTextId) {
      setError('Create or select a document first.');
      return;
    }
    await handlePdfUpload(file);
  }

  useEffect(() => {
    const onDragEnter = (e) => {
      if (!e.dataTransfer?.types?.includes('Files')) return;
      e.preventDefault();
      dropCountRef.current++;
      setPageDropActive(true);
    };
    const onDragLeave = (e) => {
      e.preventDefault();
      dropCountRef.current--;
      if (dropCountRef.current <= 0) {
        dropCountRef.current = 0;
        setPageDropActive(false);
      }
    };
    const onDragOver = (e) => {
      if (!e.dataTransfer?.types?.includes('Files')) return;
      e.preventDefault();
    };
    const onPageDrop = (e) => {
      e.preventDefault();
      dropCountRef.current = 0;
      setPageDropActive(false);
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      if (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf') {
        setError('Only PDF files are accepted.');
        return;
      }
      if (!selectedTextId) {
        setError('Select a text before dropping a PDF.');
        return;
      }
      handlePdfUpload(file);
    };

    document.addEventListener('dragenter', onDragEnter);
    document.addEventListener('dragleave', onDragLeave);
    document.addEventListener('dragover', onDragOver);
    document.addEventListener('drop', onPageDrop);
    return () => {
      document.removeEventListener('dragenter', onDragEnter);
      document.removeEventListener('dragleave', onDragLeave);
      document.removeEventListener('dragover', onDragOver);
      document.removeEventListener('drop', onPageDrop);
    };
  }, [handlePdfUpload, selectedTextId]);

  // Export handlers
  async function openExport() {
    setNewSectionLabel('');
    setShowExport(true);

    let saved = null;
    try {
      const data = await api.get(`/api/projects/${id}/export-settings`);
      saved = data.settings;
    } catch (_) { /* no saved settings */ }

    if (saved?.tocFlat && Array.isArray(saved.tocFlat) && saved.tocFlat.length > 0) {
      const currentTextIds = new Set(texts.map((t) => t.id));
      const kept = saved.tocFlat.filter(
        (item) => item.type === 'section' || (item.textId != null && currentTextIds.has(item.textId))
      );
      const savedTextIds = new Set(kept.filter((i) => i.textId != null).map((i) => i.textId));
      const newTexts = texts.filter((t) => !savedTextIds.has(t.id));

      let nextId = kept.length > 0 ? Math.max(...kept.map((i) => i.id || 0)) + 1 : 1;
      const restoredItems = kept.map((item) => ({ ...item, id: item.id || nextId++ }));
      const appendedItems = newTexts.map((t) => ({
        id: nextId++, type: 'text', label: t.name, depth: 0, textId: t.id,
      }));

      setTocItems([...restoredItems, ...appendedItems]);
      setExportMeta({
        title: saved.meta?.title || project?.name || '',
        creators: saved.meta?.creators || '',
        date: saved.meta?.date || new Date().toISOString().split('T')[0],
        language: saved.meta?.language || project?.default_language || 'en',
        rights: saved.meta?.rights || '',
        description: saved.meta?.description || project?.description || '',
      });
    } else {
      let nextId = 1;
      setTocItems(texts.map((t) => ({
        id: nextId++, type: 'text', label: t.name, depth: 0, textId: t.id,
      })));
      setExportMeta({
        title: project?.name || '',
        creators: '',
        date: new Date().toISOString().split('T')[0],
        language: project?.default_language || 'en',
        rights: '',
        description: project?.description || '',
      });
    }
  }

  function tocNextId() {
    return tocItems.length > 0 ? Math.max(...tocItems.map((i) => i.id)) + 1 : 1;
  }

  function tocMove(index, direction) {
    const newIdx = index + direction;
    if (newIdx < 0 || newIdx >= tocItems.length) return;
    setTocItems((prev) => {
      const items = [...prev];
      [items[index], items[newIdx]] = [items[newIdx], items[index]];
      return items;
    });
  }

  function tocIndent(index, delta) {
    setTocItems((prev) => prev.map((item, i) => {
      if (i !== index) return item;
      const newDepth = Math.max(0, Math.min(5, item.depth + delta));
      return { ...item, depth: newDepth };
    }));
  }

  function tocRemove(index) {
    setTocItems((prev) => prev.filter((_, i) => i !== index));
  }

  function tocAddSection() {
    const label = newSectionLabel.trim();
    if (!label) return;
    setTocItems((prev) => [...prev, { id: tocNextId(), type: 'section', label, depth: 0 }]);
    setNewSectionLabel('');
  }

  function flatToNested(items) {
    const root = [];
    const stack = [{ depth: -1, children: root }];
    for (const item of items) {
      const node = {
        type: item.type,
        label: item.label,
        ...(item.textId != null && { textId: item.textId }),
        children: [],
      };
      while (stack.length > 1 && stack[stack.length - 1].depth >= item.depth) {
        stack.pop();
      }
      stack[stack.length - 1].children.push(node);
      stack.push({ depth: item.depth, children: node.children });
    }
    return root;
  }

  async function handleExport() {
    if (tocItems.length === 0) {
      setError('Add at least one item to the table of contents.');
      return;
    }
    setExporting(true);
    try {
      const res = await fetch(`${BASE}/api/projects/${id}/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ meta: exportMeta, toc: flatToNested(tocItems), tocFlat: tocItems }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Export failed');
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${project.name.replace(/[^a-zA-Z0-9_-]/g, '_')}.zip`;
      a.click();
      URL.revokeObjectURL(url);
      setShowExport(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setExporting(false);
    }
  }

  if (loading) {
    return (
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <Skeleton.Box className="h-8 w-64 mb-2" />
        <Skeleton.Box className="h-4 w-96 mb-8" />
        <div className="space-y-3">
          {Array.from({ length: 4 }, (_, i) => <Skeleton.TextRow key={i} />)}
        </div>
      </div>
    );
  }

  if (!project) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="p-4 rounded-lg bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 text-sm">
          Project not found.
        </div>
      </div>
    );
  }

  const role = project?.role || 'viewer';
  const canEdit = role === 'owner' || role === 'editor';

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {/* Toast */}
      {toast && (
        <div className="fixed top-20 right-4 z-50 px-4 py-3 rounded-xl bg-green-50 border border-green-200 text-green-700 text-sm shadow-lg">
          {toast}
        </div>
      )}

      {/* Global upload progress overlay — visible regardless of panel state */}
      {uploading && (
        <div className="fixed top-20 right-4 z-50 px-5 py-4 rounded-xl bg-white dark:bg-slate-800 border border-cail-blue/30 shadow-lg max-w-sm">
          <div className="flex items-center gap-3">
            <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-cail-blue flex-shrink-0"></div>
            <div>
              <p className="text-sm font-medium text-cail-dark dark:text-slate-200">Processing PDF...</p>
              {uploadProgress && <p className="text-xs text-gray-500 mt-0.5">{uploadProgress}</p>}
            </div>
          </div>
        </div>
      )}

      {/* Single hidden file input — always in DOM */}
      <input
        ref={fileInputRef}
        type="file"
        accept="application/pdf,.pdf"
        className="hidden"
        onChange={handlePdfSelect}
      />

      {/* Back button */}
      <Link
        to="/"
        className="inline-flex items-center gap-2 text-sm text-gray-500 hover:text-cail-dark mb-6 group"
      >
        <svg className="w-4 h-4 group-hover:-translate-x-0.5 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
        </svg>
        Back to Dashboard
      </Link>

      {error && (
        <div className="mb-6 p-3 rounded-lg bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 text-sm">
          {error}
          <button onClick={() => setError('')} className="ml-2 font-medium hover:underline">Dismiss</button>
        </div>
      )}

      {/* Project header */}
      <div className="bg-white dark:bg-slate-800 rounded-2xl border border-gray-100 dark:border-slate-700 p-6 mb-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="flex-1">
            <div className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-amber-100 text-amber-700 mb-3">
              PDF to HTML
            </div>
            {editingName && role === 'owner' ? (
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={nameValue}
                  onChange={(e) => setNameValue(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && saveName()}
                  className="font-display font-semibold text-xl text-cail-dark px-2 py-1 rounded-lg border border-gray-200 dark:border-slate-700 focus:border-cail-blue outline-none"
                  autoFocus
                />
                <button onClick={saveName} className="text-sm text-cail-blue hover:text-cail-navy font-medium">Save</button>
                <button onClick={() => { setEditingName(false); setNameValue(project.name); }} className="text-sm text-gray-400 hover:text-gray-600 dark:hover:text-slate-300 dark:text-slate-400">Cancel</button>
              </div>
            ) : (
              <div className="flex items-center gap-3">
                <h1
                  className={`font-display font-semibold text-2xl text-cail-dark ${role === 'owner' ? 'cursor-pointer hover:text-cail-blue transition-colors' : ''}`}
                  onClick={role === 'owner' ? () => setEditingName(true) : undefined}
                  title={role === 'owner' ? 'Click to edit' : undefined}
                >
                  {project.name}
                </h1>
                {role !== 'owner' && (
                  <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                    role === 'editor' ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-slate-300'
                  }`}>
                    {role === 'editor' ? 'Editor' : 'Viewer'}
                  </span>
                )}
              </div>
            )}
            {project.description && (
              <p className="text-sm text-gray-500 mt-1">{project.description}</p>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2 sm:gap-3">
            {canEdit && (
              <button
                onClick={() => setShowAddSection((v) => !v)}
                className={`px-4 py-2 rounded-full text-sm font-medium transition-colors ${
                  showAddSection
                    ? 'bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-slate-300 hover:bg-gray-200 dark:hover:bg-slate-600'
                    : 'bg-cail-blue text-white hover:bg-cail-navy'
                }`}
              >
                {showAddSection ? 'Cancel' : '+ New Text'}
              </button>
            )}
            {canEdit && texts.length > 1 && (
              <button
                onClick={() => setEditMode((v) => !v)}
                className={`px-4 py-2 rounded-full text-sm font-medium transition-colors ${
                  editMode
                    ? 'bg-cail-navy text-white hover:bg-cail-dark'
                    : 'bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-slate-300 hover:bg-gray-200 dark:hover:bg-slate-600'
                }`}
              >
                {editMode ? 'Done' : 'Edit'}
              </button>
            )}
            <button
              onClick={openExport}
              className="px-4 py-2 rounded-full bg-cail-teal text-white text-sm font-medium hover:bg-cail-azure transition-colors"
            >
              Export to Manifold
            </button>
            {role === 'owner' && (
              <button
                onClick={() => setShowShare(true)}
                className="px-4 py-2 rounded-full bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-slate-300 text-sm font-medium hover:bg-gray-200 dark:hover:bg-slate-600 transition-colors"
              >
                Share
              </button>
            )}
            {role === 'owner' && (
              <button
                onClick={deleteProject}
                className="px-4 py-2 rounded-full bg-red-50 text-red-600 text-sm font-medium hover:bg-red-100 transition-colors"
              >
                Delete
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Add text + Upload area */}
      {showAddSection && canEdit && (
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        {/* Add text */}
        <div className="bg-white dark:bg-slate-800 rounded-2xl border border-gray-100 dark:border-slate-700 p-6">
          <h2 className="font-display font-semibold text-lg text-cail-dark mb-4">Add Document</h2>
          <form onSubmit={createText} className="flex gap-2">
            <input
              type="text"
              value={newTextName}
              onChange={(e) => setNewTextName(e.target.value)}
              placeholder="Document name (e.g., Chapter 1)"
              className="flex-1 px-4 py-2.5 rounded-xl border border-gray-200 dark:border-slate-700 focus:border-cail-blue focus:ring-2 focus:ring-cail-blue/20 outline-none transition text-sm"
            />
            <button
              type="submit"
              disabled={creatingText || !newTextName.trim()}
              className="px-5 py-2.5 rounded-full bg-cail-blue text-white text-sm font-medium hover:bg-cail-navy transition-colors disabled:opacity-50"
            >
              {creatingText ? '...' : 'Add'}
            </button>
          </form>
        </div>

        {/* Upload zone */}
        <div className="bg-white dark:bg-slate-800 rounded-2xl border border-gray-100 dark:border-slate-700 p-6">
          <h2 className="font-display font-semibold text-lg text-cail-dark mb-4">Import PDF</h2>

          {texts.length > 0 ? (
            <>
              <select
                value={selectedTextId}
                onChange={(e) => setSelectedTextId(e.target.value)}
                className="w-full mb-3 text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-slate-700 focus:border-cail-blue outline-none"
              >
                <option value="">Select a document...</option>
                {texts.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>

              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading || !selectedTextId}
                className="w-full px-4 py-3 rounded-xl bg-cail-blue text-white text-sm font-medium hover:bg-cail-navy transition-colors disabled:opacity-50"
              >
                {uploading ? 'Processing...' : 'Choose PDF'}
              </button>
              {uploadProgress && (
                <div className="mt-3 flex items-center gap-2">
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-cail-blue flex-shrink-0"></div>
                  <p className="text-xs text-gray-500 dark:text-slate-400">{uploadProgress}</p>
                </div>
              )}
            </>
          ) : (
            <p className="text-sm text-gray-400 dark:text-slate-500">Create a document first, then import a PDF.</p>
          )}
        </div>
      </div>
      )}

      {/* Texts list */}
      <div className="space-y-4">
        <h2 className="font-display font-semibold text-lg text-cail-dark dark:text-slate-200">
          Documents ({totalTexts || texts.length})
        </h2>

        {texts.length === 0 && (
          <div className="text-center py-12 bg-white dark:bg-slate-800 rounded-2xl border border-gray-100 dark:border-slate-700">
            <p className="text-sm text-gray-500 dark:text-slate-400">No documents yet. Click &quot;+ New Text&quot; to get started.</p>
          </div>
        )}

        {texts.map((text, idx) => (
          <div
            key={text.id}
            draggable={editMode}
            onDragStart={editMode ? (e) => handleDragStart(e, idx) : undefined}
            onDragOver={editMode ? (e) => handleDragOver(e, idx) : undefined}
            onDragEnd={editMode ? handleDragEnd : undefined}
            onDrop={editMode ? (e) => handleReorderDrop(e, idx) : undefined}
            className={`bg-white rounded-2xl border p-5 transition-all flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 ${
              editMode ? 'cursor-grab active:cursor-grabbing' : 'hover:shadow-md'
            } ${dragIdx === idx ? 'opacity-40' : ''} ${
              dragOverIdx === idx && dragIdx !== idx
                ? 'border-t-2 border-cail-blue border-x-gray-100 border-b-gray-100'
                : 'border-gray-100'
            }`}
          >
            {/* Drag handle (edit mode only) */}
            {editMode && (
              <div className="flex items-center flex-shrink-0 text-gray-400 dark:text-slate-500">
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                  <circle cx="9" cy="6" r="1.5" />
                  <circle cx="15" cy="6" r="1.5" />
                  <circle cx="9" cy="12" r="1.5" />
                  <circle cx="15" cy="12" r="1.5" />
                  <circle cx="9" cy="18" r="1.5" />
                  <circle cx="15" cy="18" r="1.5" />
                </svg>
              </div>
            )}

            <div className="flex-1">
              <Link
                to={`/texts/${text.id}`}
                className="font-display font-semibold text-cail-dark hover:text-cail-blue transition-colors"
              >
                {text.name}
              </Link>
              <div className="flex items-center gap-3 mt-1 flex-wrap">
                <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                  text.html_content ? 'bg-green-50 text-green-700' : 'bg-gray-50 dark:bg-slate-900 text-gray-600'
                }`}>
                  {text.html_content ? 'HTML ready' : 'Awaiting import'}
                </span>
                {text.source_pdf_name && (
                  <span className="text-xs text-gray-400 dark:text-slate-500">
                    {text.source_pdf_name}
                  </span>
                )}
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Link
                to={`/texts/${text.id}`}
                className="px-4 py-1.5 rounded-full bg-cail-blue/10 text-cail-blue text-xs font-medium hover:bg-cail-blue/20 transition-colors"
              >
                Open
              </Link>
              {canEdit && (
                <button
                  onClick={() => {
                    setSelectedTextId(String(text.id));
                    setTimeout(() => fileInputRef.current?.click(), 50);
                  }}
                  className="px-3 py-1.5 rounded-full text-xs font-medium text-gray-600 hover:bg-gray-100 dark:hover:bg-slate-700 transition-colors"
                >
                  {text.source_pdf_name ? 'Replace PDF' : 'Upload PDF'}
                </button>
              )}
              {canEdit && (
                <button
                  onClick={() => deleteText(text.id)}
                  className="px-3 py-1.5 rounded-full text-xs font-medium text-red-500 hover:bg-red-50 transition-colors"
                >
                  Delete
                </button>
              )}
            </div>
          </div>
        ))}

        <Pagination
          currentPage={textsPage}
          totalPages={Math.ceil(totalTexts / textsPageSize)}
          onPageChange={handleTextsPageChange}
          totalItems={totalTexts}
          pageSize={textsPageSize}
        />
      </div>

      {pageDropActive && (
        <div className="fixed inset-0 z-50 bg-cail-blue/10 backdrop-blur-sm flex items-center justify-center pointer-events-none">
          <div className="bg-white rounded-2xl border-2 border-dashed border-cail-blue p-12 text-center shadow-2xl">
            <svg className="w-16 h-16 mx-auto text-cail-blue mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
            </svg>
            <p className="font-display font-semibold text-lg text-cail-dark dark:text-slate-200">Drop PDF here</p>
            <p className="text-sm text-gray-500 mt-1">{selectedTextId ? 'Upload to selected text' : 'Select a text first'}</p>
          </div>
        </div>
      )}

      <SharePanel projectId={Number(id)} open={showShare} onClose={() => setShowShare(false)} />

      {/* Export Modal */}
      {showExport && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
          <div className="bg-white rounded-2xl shadow-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto p-6">
            <div className="flex items-center justify-between mb-6">
              <h2 className="font-display font-semibold text-xl text-cail-dark dark:text-slate-200">Export to Manifold</h2>
              <button onClick={() => setShowExport(false)} className="text-gray-400 hover:text-gray-600 dark:hover:text-slate-300 dark:text-slate-400">
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* TOC Builder */}
            <div className="mb-6">
              <h3 className="text-sm font-medium text-gray-700 mb-2">Table of Contents</h3>
              <div className="space-y-1 mb-3">
                {tocItems.map((item, idx) => (
                  <div
                    key={item.id}
                    className="flex items-center gap-1 py-1.5 px-2 rounded-lg bg-gray-50 dark:bg-slate-900 hover:bg-gray-100 dark:hover:bg-slate-700 transition-colors"
                    style={{ marginLeft: item.depth * 24 + 'px' }}
                  >
                    <span className="w-5 h-5 flex items-center justify-center text-gray-400 flex-shrink-0">
                      {item.type === 'section' ? (
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                        </svg>
                      ) : (
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                        </svg>
                      )}
                    </span>

                    <span className={`flex-1 text-sm truncate ${item.type === 'section' ? 'font-semibold text-cail-dark' : 'text-gray-700'}`}>
                      {item.label}
                    </span>

                    <div className="flex items-center gap-0.5 flex-shrink-0">
                      <button
                        onClick={() => tocIndent(idx, -1)}
                        disabled={item.depth === 0}
                        className="p-1 rounded text-gray-400 hover:text-cail-blue hover:bg-white disabled:opacity-30 disabled:hover:text-gray-400 disabled:hover:bg-transparent"
                        title="Outdent"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                        </svg>
                      </button>
                      <button
                        onClick={() => tocIndent(idx, 1)}
                        disabled={item.depth >= 5}
                        className="p-1 rounded text-gray-400 hover:text-cail-blue hover:bg-white disabled:opacity-30 disabled:hover:text-gray-400 disabled:hover:bg-transparent"
                        title="Indent"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                        </svg>
                      </button>
                      <button
                        onClick={() => tocMove(idx, -1)}
                        disabled={idx === 0}
                        className="p-1 rounded text-gray-400 hover:text-cail-blue hover:bg-white disabled:opacity-30 disabled:hover:text-gray-400 disabled:hover:bg-transparent"
                        title="Move up"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
                        </svg>
                      </button>
                      <button
                        onClick={() => tocMove(idx, 1)}
                        disabled={idx === tocItems.length - 1}
                        className="p-1 rounded text-gray-400 hover:text-cail-blue hover:bg-white disabled:opacity-30 disabled:hover:text-gray-400 disabled:hover:bg-transparent"
                        title="Move down"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                        </svg>
                      </button>
                      <button
                        onClick={() => tocRemove(idx)}
                        className="p-1 rounded text-gray-400 hover:text-red-500 hover:bg-white"
                        title="Remove"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                  </div>
                ))}
                {tocItems.length === 0 && (
                  <p className="text-sm text-gray-400 text-center py-4">No items. Add texts or sections below.</p>
                )}
              </div>

              {/* Add Section */}
              <div className="flex gap-2">
                <input
                  type="text"
                  value={newSectionLabel}
                  onChange={(e) => setNewSectionLabel(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && tocAddSection()}
                  placeholder="Section heading..."
                  className="flex-1 px-3 py-1.5 rounded-lg border border-gray-200 dark:border-slate-700 focus:border-cail-blue outline-none text-sm"
                />
                <button
                  onClick={tocAddSection}
                  disabled={!newSectionLabel.trim()}
                  className="px-3 py-1.5 rounded-lg bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-slate-300 text-xs font-medium hover:bg-gray-200 dark:hover:bg-slate-600 transition-colors disabled:opacity-50"
                >
                  + Section
                </button>
              </div>
            </div>

            {/* Metadata fields */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
              {[
                { key: 'title', label: 'Title' },
                { key: 'creators', label: 'Creators' },
                { key: 'date', label: 'Date', type: 'date' },
                { key: 'language', label: 'Language' },
                { key: 'rights', label: 'Rights' },
              ].map((f) => (
                <div key={f.key}>
                  <label className="block text-sm font-medium text-gray-700 mb-1">{f.label}</label>
                  <input
                    type={f.type || 'text'}
                    value={exportMeta[f.key]}
                    onChange={(e) => setExportMeta((m) => ({ ...m, [f.key]: e.target.value }))}
                    className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-slate-700 focus:border-cail-blue outline-none text-sm"
                  />
                </div>
              ))}
              <div className="sm:col-span-2">
                <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
                <textarea
                  value={exportMeta.description}
                  onChange={(e) => setExportMeta((m) => ({ ...m, description: e.target.value }))}
                  rows={2}
                  className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-slate-700 focus:border-cail-blue outline-none text-sm resize-none"
                />
              </div>
            </div>

            <div className="flex justify-end gap-3">
              <button
                onClick={() => setShowExport(false)}
                className="px-4 py-2 rounded-full text-sm font-medium text-gray-600 hover:bg-gray-100 dark:hover:bg-slate-700 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleExport}
                disabled={exporting || tocItems.length === 0}
                className="px-6 py-2 rounded-full bg-cail-teal text-white text-sm font-medium hover:bg-cail-azure transition-colors disabled:opacity-50"
              >
                {exporting ? 'Exporting...' : 'Download ZIP'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
