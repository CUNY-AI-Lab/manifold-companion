import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { api } from '../api/client';

const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Spanish' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
  { code: 'it', label: 'Italian' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'ru', label: 'Russian' },
  { code: 'zh', label: 'Chinese' },
  { code: 'ja', label: 'Japanese' },
  { code: 'ko', label: 'Korean' },
  { code: 'ar', label: 'Arabic' },
  { code: 'hi', label: 'Hindi' },
  { code: 'la', label: 'Latin' },
  { code: 'grc', label: 'Ancient Greek' },
  { code: 'he', label: 'Hebrew' },
  { code: 'yi', label: 'Yiddish' },
];

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
  const [langValue, setLangValue] = useState('en');

  // New text form
  const [newTextName, setNewTextName] = useState('');
  const [creatingText, setCreatingText] = useState(false);

  // Upload state
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState('');
  const [selectedTextForUpload, setSelectedTextForUpload] = useState(null);
  const [dragOver, setDragOver] = useState(false);

  // Export modal
  const [showExport, setShowExport] = useState(false);
  const [exportTextIds, setExportTextIds] = useState([]);
  const [exportMeta, setExportMeta] = useState({
    title: '', creators: '', date: '', language: 'en', rights: '', description: ''
  });
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    loadProject();
  }, [id]);

  async function loadProject() {
    try {
      const data = await api.get(`/api/projects/${id}`);
      setProject(data);
      setTexts(data.texts || []);
      setNameValue(data.name);
      setLangValue(data.default_language || 'en');
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

  async function saveLanguage(lang) {
    setLangValue(lang);
    try {
      await api.put(`/api/projects/${id}`, { default_language: lang });
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

  async function deleteProject() {
    if (!window.confirm('Delete this entire project? This cannot be undone.')) return;
    try {
      await api.del(`/api/projects/${id}`);
      navigate('/');
    } catch (err) {
      setError(err.message);
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

      for (const file of files) {
        if (file.type === 'application/pdf') {
          setUploadProgress(`Splitting PDF: ${file.name}...`);
          const pageImages = await pdfToImages(file);
          allImages.push(...pageImages);
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

      // Upload in batches of 20
      const batchSize = 20;
      let totalUploaded = 0;

      for (let i = 0; i < allImages.length; i += batchSize) {
        const batch = allImages.slice(i, i + batchSize);
        const formData = new FormData();
        batch.forEach((img) => formData.append('images', img));

        await api.upload(`/api/texts/${textId}/upload`, formData);
        totalUploaded += batch.length;
        setUploadProgress(`Uploaded ${totalUploaded}/${allImages.length} images...`);
      }

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
    const files = Array.from(e.dataTransfer.files || []);
    if (files.length > 0 && selectedTextForUpload) {
      processAndUpload(files, selectedTextForUpload);
    }
  }

  // Export handlers
  function openExport() {
    setExportTextIds(texts.map((t) => t.id));
    setExportMeta({
      title: project?.name || '',
      creators: '',
      date: new Date().toISOString().split('T')[0],
      language: project?.default_language || 'en',
      rights: '',
      description: project?.description || '',
    });
    setShowExport(true);
  }

  async function handleExport() {
    if (exportTextIds.length === 0) {
      setError('Select at least one text to export.');
      return;
    }
    setExporting(true);
    try {
      const res = await fetch(`/api/projects/${id}/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ meta: exportMeta, textIds: exportTextIds }),
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

  function toggleExportText(textId) {
    setExportTextIds((prev) =>
      prev.includes(textId) ? prev.filter((t) => t !== textId) : [...prev, textId]
    );
  }

  if (loading) {
    return (
      <div className="flex justify-center items-center min-h-[60vh]">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-cail-blue"></div>
      </div>
    );
  }

  if (!project) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="p-4 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm">
          Project not found.
        </div>
      </div>
    );
  }

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
        <div className="mb-6 p-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm">
          {error}
          <button onClick={() => setError('')} className="ml-2 font-medium hover:underline">Dismiss</button>
        </div>
      )}

      {/* Project header */}
      <div className="bg-white rounded-2xl border border-gray-100 p-6 mb-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="flex-1">
            {editingName ? (
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={nameValue}
                  onChange={(e) => setNameValue(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && saveName()}
                  className="font-display font-semibold text-xl text-cail-dark px-2 py-1 rounded-lg border border-gray-200 focus:border-cail-blue outline-none"
                  autoFocus
                />
                <button onClick={saveName} className="text-sm text-cail-blue hover:text-cail-navy font-medium">Save</button>
                <button onClick={() => { setEditingName(false); setNameValue(project.name); }} className="text-sm text-gray-400 hover:text-gray-600">Cancel</button>
              </div>
            ) : (
              <h1
                className="font-display font-semibold text-2xl text-cail-dark cursor-pointer hover:text-cail-blue transition-colors"
                onClick={() => setEditingName(true)}
                title="Click to edit"
              >
                {project.name}
              </h1>
            )}
            {project.description && (
              <p className="text-sm text-gray-500 mt-1">{project.description}</p>
            )}
          </div>

          <div className="flex items-center gap-3">
            <select
              value={langValue}
              onChange={(e) => saveLanguage(e.target.value)}
              className="text-sm px-3 py-1.5 rounded-lg border border-gray-200 focus:border-cail-blue outline-none"
            >
              {LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>{l.label}</option>
              ))}
            </select>
            <button
              onClick={openExport}
              className="px-4 py-2 rounded-full bg-cail-teal text-white text-sm font-medium hover:bg-cail-azure transition-colors"
            >
              Export to Manifold
            </button>
            <button
              onClick={deleteProject}
              className="px-4 py-2 rounded-full bg-red-50 text-red-600 text-sm font-medium hover:bg-red-100 transition-colors"
            >
              Delete
            </button>
          </div>
        </div>
      </div>

      {/* Add text + Upload area */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        {/* Add text */}
        <div className="bg-white rounded-2xl border border-gray-100 p-6">
          <h2 className="font-display font-semibold text-lg text-cail-dark mb-4">Add Text</h2>
          <form onSubmit={createText} className="flex gap-2">
            <input
              type="text"
              value={newTextName}
              onChange={(e) => setNewTextName(e.target.value)}
              placeholder="Text name (e.g., Chapter 1)"
              className="flex-1 px-4 py-2.5 rounded-xl border border-gray-200 focus:border-cail-blue focus:ring-2 focus:ring-cail-blue/20 outline-none transition text-sm"
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
        <div className="bg-white rounded-2xl border border-gray-100 p-6">
          <h2 className="font-display font-semibold text-lg text-cail-dark mb-4">Upload Images</h2>

          {texts.length > 0 ? (
            <>
              <select
                value={selectedTextForUpload || ''}
                onChange={(e) => setSelectedTextForUpload(Number(e.target.value) || null)}
                className="w-full mb-3 text-sm px-3 py-2 rounded-lg border border-gray-200 focus:border-cail-blue outline-none"
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
                onDrop={handleDrop}
                onClick={() => selectedTextForUpload && fileInputRef.current?.click()}
                className={`border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition-colors ${
                  dragOver ? 'border-cail-blue bg-cail-blue/5' : 'border-gray-200 hover:border-cail-blue/50'
                } ${!selectedTextForUpload ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                {uploading ? (
                  <div>
                    <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-cail-blue mx-auto mb-2"></div>
                    <p className="text-sm text-gray-500">{uploadProgress}</p>
                  </div>
                ) : (
                  <>
                    <svg className="w-8 h-8 text-gray-400 mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                    </svg>
                    <p className="text-sm text-gray-500">
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
                accept="image/*,.pdf"
                onChange={handleFileSelect}
                className="hidden"
              />
            </>
          ) : (
            <p className="text-sm text-gray-400">Create a text first, then upload images to it.</p>
          )}
        </div>
      </div>

      {/* Texts list */}
      <div className="space-y-4">
        <h2 className="font-display font-semibold text-lg text-cail-dark">
          Texts ({texts.length})
        </h2>

        {texts.length === 0 && (
          <div className="text-center py-12 bg-white rounded-2xl border border-gray-100">
            <p className="text-sm text-gray-500">No texts yet. Add one above to get started.</p>
          </div>
        )}

        {texts.map((text) => (
          <div
            key={text.id}
            className="bg-white rounded-2xl border border-gray-100 p-5 hover:shadow-md transition-shadow flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3"
          >
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
                  'bg-gray-50 text-gray-600'
                }`}>
                  {text.status === 'ocrd' ? 'OCR Complete' :
                   text.status === 'processing' ? 'Processing' :
                   'Pending'}
                </span>
                <span className="text-xs text-gray-400">
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
              <button
                onClick={() => deleteText(text.id)}
                className="px-3 py-1.5 rounded-full text-xs font-medium text-red-500 hover:bg-red-50 transition-colors"
              >
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Export Modal */}
      {showExport && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
          <div className="bg-white rounded-2xl shadow-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto p-6">
            <div className="flex items-center justify-between mb-6">
              <h2 className="font-display font-semibold text-xl text-cail-dark">Export to Manifold</h2>
              <button onClick={() => setShowExport(false)} className="text-gray-400 hover:text-gray-600">
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Text selection */}
            <div className="mb-6">
              <h3 className="text-sm font-medium text-gray-700 mb-2">Select Texts</h3>
              <div className="space-y-2">
                {texts.map((t) => (
                  <label key={t.id} className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={exportTextIds.includes(t.id)}
                      onChange={() => toggleExportText(t.id)}
                      className="rounded border-gray-300 text-cail-blue focus:ring-cail-blue"
                    />
                    <span className="text-sm">{t.name}</span>
                  </label>
                ))}
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
                    className="w-full px-3 py-2 rounded-lg border border-gray-200 focus:border-cail-blue outline-none text-sm"
                  />
                </div>
              ))}
              <div className="sm:col-span-2">
                <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
                <textarea
                  value={exportMeta.description}
                  onChange={(e) => setExportMeta((m) => ({ ...m, description: e.target.value }))}
                  rows={2}
                  className="w-full px-3 py-2 rounded-lg border border-gray-200 focus:border-cail-blue outline-none text-sm resize-none"
                />
              </div>
            </div>

            <div className="flex justify-end gap-3">
              <button
                onClick={() => setShowExport(false)}
                className="px-4 py-2 rounded-full text-sm font-medium text-gray-600 hover:bg-gray-100 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleExport}
                disabled={exporting || exportTextIds.length === 0}
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
