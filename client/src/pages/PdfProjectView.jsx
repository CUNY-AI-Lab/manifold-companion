import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { convertPdfToHtmlWithBedrock } from '../lib/pdfBedrockPipeline';

export default function PdfProjectView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const fileInputRef = useRef(null);
  const [project, setProject] = useState(null);
  const [texts, setTexts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [newTextName, setNewTextName] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [creating, setCreating] = useState(false);
  const [selectedTextId, setSelectedTextId] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState('');

  const loadProject = useCallback(async () => {
    try {
      const data = await api.get(`/api/projects/${id}`);
      setProject(data);
      setTexts(data.texts || []);
      if (!selectedTextId && data.texts?.length) {
        setSelectedTextId(String(data.texts[0].id));
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [id, selectedTextId]);

  useEffect(() => {
    loadProject();
  }, [loadProject]);

  async function createText(e) {
    e.preventDefault();
    if (!newTextName.trim()) return;
    setCreating(true);
    setError('');
    try {
      const text = await api.post(`/api/projects/${id}/texts`, { name: newTextName.trim() });
      setNewTextName('');
      setShowAdd(false);
      setSelectedTextId(String(text.id));
      await loadProject();
    } catch (err) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  }

  async function deleteTextRecord(textId, textName) {
    const confirmed = window.confirm(`Delete "${textName}"? This will remove the saved HTML and retained source PDF.`);
    if (!confirmed) return;

    setError('');
    try {
      await api.del(`/api/texts/${textId}`);
      if (selectedTextId === String(textId)) {
        const remaining = texts.filter((text) => text.id !== textId);
        setSelectedTextId(remaining[0] ? String(remaining[0].id) : '');
      }
      await loadProject();
    } catch (err) {
      setError(err.message);
    }
  }

  async function handlePdfSelect(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!selectedTextId) {
      setError('Create or select a document first.');
      return;
    }

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
        } else if (progress.stage === 'upload-images') {
          setUploadProgress('Uploading page images...');
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
      <div className="max-w-4xl mx-auto px-4 py-8">
        <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm">Project not found.</div>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {toast && (
        <div className="fixed top-20 right-4 z-50 px-4 py-3 rounded-xl bg-green-50 border border-green-200 text-green-700 text-sm shadow-lg">
          {toast}
        </div>
      )}

      <Link to="/" className="inline-flex items-center gap-2 text-sm text-gray-500 hover:text-cail-dark mb-6">
        <span>&larr;</span>
        Back to Dashboard
      </Link>

      {error && (
        <div className="mb-6 p-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm">
          {error}
        </div>
      )}

      <div className="bg-white rounded-2xl border border-gray-100 p-6 mb-6">
        <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-6">
          <div>
            <div className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-amber-100 text-amber-700 mb-3">
              PDF to HTML
            </div>
            <h1 className="font-display font-semibold text-2xl text-cail-dark">{project.name}</h1>
            {project.description && <p className="text-sm text-gray-500 mt-2">{project.description}</p>}
            <p className="text-sm text-gray-500 mt-3">
              Import one PDF per document. The original PDF is retained with the project and expires on the same 90-day schedule as image-based projects.
            </p>
          </div>

          <div className="w-full lg:w-[22rem] bg-cail-cream rounded-2xl p-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-display font-semibold text-cail-dark">Import PDF</h2>
              <button
                onClick={() => setShowAdd((value) => !value)}
                className="text-sm font-medium text-cail-blue hover:text-cail-navy"
              >
                {showAdd ? 'Cancel' : '+ New Document'}
              </button>
            </div>

            {showAdd && (
              <form onSubmit={createText} className="space-y-3 mb-4">
                <input
                  type="text"
                  value={newTextName}
                  onChange={(e) => setNewTextName(e.target.value)}
                  placeholder="Document name"
                  className="w-full px-4 py-2.5 rounded-xl border border-gray-200 focus:border-cail-blue focus:ring-2 focus:ring-cail-blue/20 outline-none transition text-sm"
                />
                <button
                  type="submit"
                  disabled={creating}
                  className="w-full px-4 py-2.5 rounded-full bg-cail-blue text-white text-sm font-medium hover:bg-cail-navy disabled:opacity-50"
                >
                  {creating ? 'Creating...' : 'Create Document'}
                </button>
              </form>
            )}

            <label htmlFor="pdf-text-select" className="block text-sm font-medium text-gray-700 mb-1">
              Target document
            </label>
            <select
              id="pdf-text-select"
              value={selectedTextId}
              onChange={(e) => setSelectedTextId(e.target.value)}
              className="w-full px-4 py-2.5 rounded-xl border border-gray-200 focus:border-cail-blue focus:ring-2 focus:ring-cail-blue/20 outline-none transition text-sm bg-white mb-3"
            >
              <option value="">Select a document</option>
              {texts.map((text) => (
                <option key={text.id} value={text.id}>{text.name}</option>
              ))}
            </select>

            <input
              ref={fileInputRef}
              type="file"
              accept="application/pdf,.pdf"
              className="hidden"
              onChange={handlePdfSelect}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading || !selectedTextId}
              className="w-full px-4 py-3 rounded-2xl bg-cail-blue text-white text-sm font-medium hover:bg-cail-navy disabled:opacity-50"
            >
              {uploading ? 'Processing...' : 'Choose PDF'}
            </button>
            {uploadProgress && <p className="text-xs text-gray-500 mt-3">{uploadProgress}</p>}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        {texts.map((text) => (
          <div key={text.id} className="bg-white rounded-2xl border border-gray-100 p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="font-display font-semibold text-lg text-cail-dark">{text.name}</h2>
                <p className="text-sm text-gray-500 mt-1">
                  {text.source_pdf_name ? `Source PDF: ${text.source_pdf_name}` : 'No PDF imported yet'}
                </p>
              </div>
              <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium ${
                text.html_content ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'
              }`}>
                {text.html_content ? 'HTML ready' : 'Awaiting import'}
              </span>
            </div>

            <div className="flex items-center gap-3 mt-4">
              <Link
                to={`/texts/${text.id}`}
                className="px-4 py-2 rounded-full bg-cail-blue text-white text-sm font-medium hover:bg-cail-navy"
              >
                Open Editor
              </Link>
              <button
                onClick={() => {
                  setSelectedTextId(String(text.id));
                  fileInputRef.current?.click();
                }}
                className="px-4 py-2 rounded-full bg-gray-100 text-gray-700 text-sm font-medium hover:bg-gray-200"
              >
                {text.source_pdf_name ? 'Replace PDF' : 'Upload PDF'}
              </button>
              <button
                onClick={() => deleteTextRecord(text.id, text.name)}
                className="px-4 py-2 rounded-full bg-red-50 text-red-700 text-sm font-medium hover:bg-red-100"
              >
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>

      {!texts.length && (
        <div className="bg-white rounded-2xl border border-gray-100 p-10 text-center text-sm text-gray-500">
          Create a document, then import a PDF to generate editable HTML.
        </div>
      )}
    </div>
  );
}
