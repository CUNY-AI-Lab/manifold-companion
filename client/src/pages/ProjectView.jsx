import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { api, BASE } from '../api/client';
import SharePanel from '../components/SharePanel';
import { SplitModal, MergeModal } from '../components/SplitMergeModals';
import Skeleton from '../components/Skeleton';

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB'];
  let i = 0;
  let val = bytes;
  while (val >= 1024 && i < units.length - 1) { val /= 1024; i++; }
  return `${val.toFixed(1)} ${units[i]}`;
}

/**
 * Resize a canvas-based image to ensure it stays under maxBytes (approx).
 * Returns a Blob (JPEG).
 */
async function resizeImageBlob(file, maxBytes = 3.5 * 1024 * 1024) {
  if (file.size <= maxBytes) return file;

  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width, height } = img;
      const scale = Math.sqrt(maxBytes / file.size) * 0.9;
      width = Math.round(width * scale);
      height = Math.round(height * scale);

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);
      canvas.toBlob(
        (blob) => resolve(new File([blob], file.name, { type: 'image/jpeg' })),
        'image/jpeg',
        0.85
      );
    };
    img.src = url;
  });
}

/**
 * Convert a HEIC/HEIF file to JPEG using heic2any.
 */
async function convertHeic(file) {
  const heic2any = (await import('heic2any')).default;
  const blob = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.9 });
  const name = file.name.replace(/\.hei[cf]$/i, '.jpg');
  return new File([blob], name, { type: 'image/jpeg' });
}

/**
 * Split a PDF into page images using pdfjs-dist.
 */
async function pdfToImages(file) {
  const pdfjsLib = await import('pdfjs-dist');
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.mjs',
    import.meta.url
  ).toString();

  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const images = [];

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: 2 });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;

    const blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', 0.9)
    );
    const name = `${file.name.replace(/\.pdf$/i, '')}_page_${String(i).padStart(3, '0')}.jpg`;
    images.push(new File([blob], name, { type: 'image/jpeg' }));
  }

  return images;
}

export default function ProjectView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const fileInputRef = useRef(null);
  const dropRef = useRef(null);

  const [project, setProject] = useState(null);
  const [texts, setTexts] = useState([]);
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
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState('');
  const [selectedTextForUpload, setSelectedTextForUpload] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [uploadSuccess, setUploadSuccess] = useState('');

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
  // Each item: { id, type: 'text'|'section', label, depth: 0-5, textId?: number }
  const [exportMeta, setExportMeta] = useState({
    title: '', creators: '', date: '', language: 'en', rights: '', description: ''
  });
  const [exporting, setExporting] = useState(false);
  const [newSectionLabel, setNewSectionLabel] = useState('');

  // Split/Merge modals
  const [showMerge, setShowMerge] = useState(false);
  const [splitTextId, setSplitTextId] = useState(null);
  const [splitPages, setSplitPages] = useState([]);

  useEffect(() => {
    loadProject();
  }, [id]);

  async function loadProject() {
    try {
      const data = await api.get(`/api/projects/${id}`);
      setProject(data);
      setTexts(data.texts || []);
      setNameValue(data.name);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
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
    try {
      await api.post(`/api/projects/${id}/texts`, { name: newTextName.trim() });
      setNewTextName('');
      setShowAddSection(false);
      await loadProject();
    } catch (err) {
      setError(err.message);
    } finally {
      setCreatingText(false);
    }
  }

  async function deleteText(textId) {
    if (!window.confirm('Delete this text and all its pages?')) return;
    try {
      await api.del(`/api/texts/${textId}`);
      await loadProject();
    } catch (err) {
      setError(err.message);
    }
  }

  async function openSplit(textId) {
    try {
      const data = await api.get(`/api/texts/${textId}/pages`);
      const pages = (data.pages || data || []).filter(p => p.filename !== '__compiled__');
      if (pages.length < 2) {
        setToast('Need at least 2 pages to split.');
        setTimeout(() => setToast(''), 3000);
        return;
      }
      setSplitPages(pages);
      setSplitTextId(textId);
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

  // File processing and upload
  const processAndUpload = useCallback(async (files, textId) => {
    if (!textId) {
      setError('Select a text to upload images to.');
      return;
    }
    setUploading(true);
    setUploadProgress('Processing files...');
    setError('');

    try {
      const allImages = [];

      for (let file of files) {
        if (file.type === 'application/pdf') {
          setUploadProgress(`Splitting PDF: ${file.name}...`);
          const pageImages = await pdfToImages(file);
          allImages.push(...pageImages);
        } else if (/\.hei[cf]$/i.test(file.name) || file.type === 'image/heic' || file.type === 'image/heif') {
          setUploadProgress(`Converting HEIC: ${file.name}...`);
          const converted = await convertHeic(file);
          const resized = await resizeImageBlob(converted);
          allImages.push(resized);
        } else if (file.type.startsWith('image/')) {
          const resized = await resizeImageBlob(file);
          allImages.push(resized);
        }
      }

      if (allImages.length === 0) {
        setError('No valid image or PDF files found.');
        setUploading(false);
        setUploadProgress('');
        return;
      }

      setUploadProgress(`Uploading ${allImages.length} image(s)...`);
      setUploadSuccess('');

      // Upload in batches of 20
      const batchSize = 20;
      let totalUploaded = 0;
      const totalBatches = Math.ceil(allImages.length / batchSize);

      for (let i = 0; i < allImages.length; i += batchSize) {
        const batchNum = Math.floor(i / batchSize) + 1;
        const batch = allImages.slice(i, i + batchSize);
        const formData = new FormData();
        batch.forEach((img) => formData.append('images', img));

        setUploadProgress(
          totalBatches > 1
            ? `Uploading batch ${batchNum}/${totalBatches} (${totalUploaded}/${allImages.length} images)...`
            : `Uploading ${totalUploaded}/${allImages.length} images...`
        );

        await api.upload(`/api/texts/${textId}/upload`, formData);
        totalUploaded += batch.length;
      }

      setUploadSuccess(`${totalUploaded} image${totalUploaded !== 1 ? 's' : ''} uploaded successfully`);
      setToast(`Uploaded ${totalUploaded} image(s) successfully.`);
      setTimeout(() => setToast(''), 3000);
      await loadProject();
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
      setUploadProgress('');
    }
  }, [id]);

  const processDroppedFiles = useCallback((fileList) => {
    const files = Array.from(fileList || []);
    if (files.length > 0 && selectedTextForUpload) {
      processAndUpload(files, selectedTextForUpload);
    }
  }, [processAndUpload, selectedTextForUpload]);

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
      if (e.dataTransfer?.files?.length) {
        processDroppedFiles(e.dataTransfer.files);
      }
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
  }, [processDroppedFiles]);

  function handleFileSelect(e) {
    const files = Array.from(e.target.files || []);
    if (files.length > 0 && selectedTextForUpload) {
      processAndUpload(files, selectedTextForUpload);
    }
    e.target.value = '';
  }

  function handleDrop(e) {
    e.preventDefault();
    setDragOver(false);
    processDroppedFiles(e.dataTransfer.files);
  }

  // Export handlers
  async function openExport() {
    setNewSectionLabel('');
    setShowExport(true);

    // Try to load saved export settings
    let saved = null;
    try {
      const data = await api.get(`/api/projects/${id}/export-settings`);
      saved = data.settings;
    } catch (_) { /* no saved settings */ }

    if (saved?.tocFlat && Array.isArray(saved.tocFlat) && saved.tocFlat.length > 0) {
      // Reconcile saved TOC with current texts
      const currentTextIds = new Set(texts.map((t) => t.id));
      // Keep saved items whose textId still exists (or sections which have no textId)
      const kept = saved.tocFlat.filter(
        (item) => item.type === 'section' || (item.textId != null && currentTextIds.has(item.textId))
      );
      // Find texts not in saved TOC and append them
      const savedTextIds = new Set(kept.filter((i) => i.textId != null).map((i) => i.textId));
      const newTexts = texts.filter((t) => !savedTextIds.has(t.id));

      let nextId = kept.length > 0 ? Math.max(...kept.map((i) => i.id || 0)) + 1 : 1;
      const restoredItems = kept.map((item) => ({ ...item, id: item.id || nextId++ }));
      const appendedItems = newTexts.map((t) => ({
        id: nextId++,
        type: 'text',
        label: t.name,
        depth: 0,
        textId: t.id,
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
      // Fresh defaults
      let nextId = 1;
      setTocItems(texts.map((t) => ({
        id: nextId++,
        type: 'text',
        label: t.name,
        depth: 0,
        textId: t.id,
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

  // TOC builder helpers
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
                  className={`font-display font-semibold text-2xl text-cail-dark${role === 'owner' ? ' cursor-pointer hover:text-cail-blue transition-colors' : ''}`}
                  onClick={role === 'owner' ? () => setEditingName(true) : undefined}
                  title={role === 'owner' ? 'Click to edit' : undefined}
                >
                  {project.name}
                </h1>
                {role !== 'owner' && (
                  <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                    role === 'editor' ? 'bg-blue-50 text-blue-700' : 'bg-gray-100 text-gray-600'
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
                    ? 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:hover:bg-slate-600'
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
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:hover:bg-slate-600'
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
                className="px-4 py-2 rounded-full bg-gray-100 text-gray-600 text-sm font-medium hover:bg-gray-200 dark:hover:bg-slate-600 transition-colors"
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
          <h2 className="font-display font-semibold text-lg text-cail-dark mb-4">Add Text</h2>
          <form onSubmit={createText} className="flex gap-2">
            <input
              type="text"
              value={newTextName}
              onChange={(e) => setNewTextName(e.target.value)}
              placeholder="Text name (e.g., Chapter 1)"
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
          <h2 className="font-display font-semibold text-lg text-cail-dark mb-4">Upload Images</h2>

          {texts.length > 0 ? (
            <>
              <select
                value={selectedTextForUpload || ''}
                onChange={(e) => setSelectedTextForUpload(Number(e.target.value) || null)}
                className="w-full mb-3 text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-slate-700 focus:border-cail-blue outline-none"
              >
                <option value="">Select a text...</option>
                {texts.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>

              <div
                ref={dropRef}
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => { setUploadSuccess(''); handleDrop(e); }}
                onClick={() => { if (selectedTextForUpload) { setUploadSuccess(''); fileInputRef.current?.click(); } }}
                className={`border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition-all ${
                  dragOver ? 'border-cail-blue bg-cail-blue/5' : uploadSuccess ? 'border-green-300 bg-green-50' : 'border-gray-200 dark:border-slate-700 hover:border-cail-blue/50'
                } ${!selectedTextForUpload ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                {uploading ? (
                  <div>
                    <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-cail-blue mx-auto mb-2"></div>
                    <p className="text-sm text-gray-500 dark:text-slate-400">{uploadProgress}</p>
                  </div>
                ) : uploadSuccess ? (
                  <div>
                    <svg className="w-8 h-8 text-green-500 mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                    <p className="text-sm text-green-700 font-medium">{uploadSuccess}</p>
                    <p className="text-xs text-green-500 mt-1">Click or drop to upload more</p>
                  </div>
                ) : (
                  <>
                    <svg className="w-8 h-8 text-gray-400 mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                    </svg>
                    <p className="text-sm text-gray-500 dark:text-slate-400">
                      Drop images or PDFs here, or click to browse
                    </p>
                    <p className="text-xs text-gray-400 mt-1">
                      PDFs will be split into page images automatically
                    </p>
                  </>
                )}
              </div>

              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="image/*,.pdf,.heic,.heif"
                onChange={handleFileSelect}
                className="hidden"
              />
            </>
          ) : (
            <p className="text-sm text-gray-400 dark:text-slate-500">Create a text first, then upload images to it.</p>
          )}
        </div>
      </div>
      )}

      {/* Texts list */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="font-display font-semibold text-lg text-cail-dark dark:text-slate-200">
            Texts ({texts.length})
          </h2>
          {canEdit && texts.length >= 2 && (
            <button
              onClick={() => setShowMerge(true)}
              className="px-3 py-1.5 rounded-full text-xs font-medium text-gray-600 hover:bg-gray-100 dark:hover:bg-slate-700 transition-colors flex items-center gap-1"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
              </svg>
              Merge
            </button>
          )}
        </div>

        {texts.length === 0 && (
          <div className="text-center py-12 bg-white dark:bg-slate-800 rounded-2xl border border-gray-100 dark:border-slate-700">
            <p className="text-sm text-gray-500 dark:text-slate-400">No texts yet. Add one above to get started.</p>
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
                  text.status === 'ocrd' ? 'bg-green-50 text-green-700' :
                  text.status === 'processing' ? 'bg-yellow-50 text-yellow-700' :
                  'bg-gray-50 dark:bg-slate-900 text-gray-600'
                }`}>
                  {text.status === 'ocrd' ? 'OCR Complete' :
                   text.status === 'processing' ? 'Processing' :
                   'Pending'}
                </span>
                <span className="text-xs text-gray-400 dark:text-slate-500">
                  {text.page_count || 0} page{(text.page_count || 0) !== 1 ? 's' : ''}
                </span>
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
                  onClick={() => openSplit(text.id)}
                  className="px-3 py-1.5 rounded-full text-xs font-medium text-gray-500 hover:bg-gray-100 dark:hover:bg-slate-700 transition-colors"
                >
                  Split
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
      </div>

      {pageDropActive && (
        <div className="fixed inset-0 z-50 bg-cail-blue/10 backdrop-blur-sm flex items-center justify-center pointer-events-none">
          <div className="bg-white rounded-2xl border-2 border-dashed border-cail-blue p-12 text-center shadow-2xl">
            <svg className="w-16 h-16 mx-auto text-cail-blue mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
            </svg>
            <p className="font-display font-semibold text-lg text-cail-dark dark:text-slate-200">Drop images here</p>
            <p className="text-sm text-gray-500 mt-1">JPEG, PNG, TIFF, BMP, WebP, or PDF files</p>
          </div>
        </div>
      )}

      <SharePanel projectId={Number(id)} open={showShare} onClose={() => setShowShare(false)} />

      {splitTextId && (
        <SplitModal
          textId={splitTextId}
          pages={splitPages}
          onClose={() => setSplitTextId(null)}
          onSplit={() => { setSplitTextId(null); loadProject(); }}
        />
      )}

      {showMerge && (
        <MergeModal
          texts={texts}
          projectId={Number(id)}
          onClose={() => setShowMerge(false)}
          onMerge={() => { setShowMerge(false); loadProject(); }}
        />
      )}

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
                    {/* Icon: folder for section, doc for text */}
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

                    {/* Label */}
                    <span className={`flex-1 text-sm truncate ${item.type === 'section' ? 'font-semibold text-cail-dark' : 'text-gray-700'}`}>
                      {item.label}
                    </span>

                    {/* Controls */}
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
                  className="px-3 py-1.5 rounded-lg bg-gray-100 text-gray-600 text-xs font-medium hover:bg-gray-200 dark:hover:bg-slate-600 transition-colors disabled:opacity-50"
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
