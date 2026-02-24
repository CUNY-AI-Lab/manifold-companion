import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, Link } from 'react-router-dom';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
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

const DC_FIELDS = [
  { key: 'dc_title', label: 'Title' },
  { key: 'dc_creator', label: 'Creator' },
  { key: 'dc_subject', label: 'Subject' },
  { key: 'dc_description', label: 'Description' },
  { key: 'dc_publisher', label: 'Publisher' },
  { key: 'dc_contributor', label: 'Contributor' },
  { key: 'dc_date', label: 'Date' },
  { key: 'dc_type', label: 'Type' },
  { key: 'dc_format', label: 'Format' },
  { key: 'dc_identifier', label: 'Identifier' },
  { key: 'dc_source', label: 'Source' },
  { key: 'dc_language', label: 'Language' },
  { key: 'dc_relation', label: 'Relation' },
  { key: 'dc_coverage', label: 'Coverage' },
  { key: 'dc_rights', label: 'Rights' },
];

const TABS = ['Pages', 'Full Text', 'Review', 'Details'];

/**
 * Safely render markdown to sanitized HTML.
 * All output is sanitized through DOMPurify to prevent XSS.
 */
function renderSanitizedMarkdown(md) {
  const rawHtml = marked.parse(md || '');
  const cleanHtml = DOMPurify.sanitize(rawHtml);
  return cleanHtml;
}

export default function TextDetail() {
  const { id } = useParams();

  const [text, setText] = useState(null);
  const [pages, setPages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [activeTab, setActiveTab] = useState('Pages');

  // OCR state
  const [ocrRunning, setOcrRunning] = useState(false);
  const [ocrProgress, setOcrProgress] = useState({ page: 0, total: 0 });

  // Full Text state
  const [fullText, setFullText] = useState('');
  const [showPreview, setShowPreview] = useState(false);
  const [textLang, setTextLang] = useState('original');
  const [translationText, setTranslationText] = useState('');
  const [savingText, setSavingText] = useState(false);
  const textareaRef = useRef(null);

  // Review state
  const [reviewPage, setReviewPage] = useState(0);
  const [pageText, setPageText] = useState('');
  const [savingPage, setSavingPage] = useState(false);

  // Details state
  const [summary, setSummary] = useState('');
  const [translation, setTranslation] = useState('');
  const [targetLang, setTargetLang] = useState('en');
  const [metadata, setMetadata] = useState({});
  const [generatingSummary, setGeneratingSummary] = useState(false);
  const [generatingTranslation, setGeneratingTranslation] = useState(false);
  const [savingSummary, setSavingSummary] = useState(false);
  const [savingTranslation, setSavingTranslation] = useState(false);
  const [savingMetadata, setSavingMetadata] = useState(false);

  // Load text data
  useEffect(() => {
    loadText();
  }, [id]);

  async function loadText() {
    try {
      const data = await api.get(`/api/texts/${id}`);
      setText(data);
      setPages(data.pages || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  // Load full text when switching to Full Text tab
  useEffect(() => {
    if (activeTab === 'Full Text') {
      loadFullText();
    }
  }, [activeTab, id]);

  async function loadFullText() {
    try {
      const data = await api.get(`/api/texts/${id}/result`);
      setFullText(data.text || '');
      // Also load translation
      const trans = await api.get(`/api/texts/${id}/translation`);
      setTranslationText(trans.translation || '');
    } catch (err) {
      // Ignore -- may not have text yet
    }
  }

  // Load details when switching to Details tab
  useEffect(() => {
    if (activeTab === 'Details') {
      loadDetails();
    }
  }, [activeTab, id]);

  async function loadDetails() {
    try {
      const [summaryData, transData, metaData] = await Promise.all([
        api.get(`/api/texts/${id}/summary`),
        api.get(`/api/texts/${id}/translation`),
        api.get(`/api/texts/${id}/metadata`),
      ]);
      setSummary(summaryData.summary || '');
      setTranslation(transData.translation || '');
      setTargetLang(transData.target_language || 'en');
      setMetadata(metaData || {});
    } catch (err) {
      // Ignore errors for missing data
    }
  }

  // Load page text for review
  useEffect(() => {
    if (activeTab === 'Review' && pages.length > 0 && pages[reviewPage]) {
      setPageText(pages[reviewPage].ocr_text || '');
    }
  }, [activeTab, reviewPage, pages]);

  // Keyboard navigation for review
  useEffect(() => {
    if (activeTab !== 'Review') return;

    function handleKey(e) {
      if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
      if (e.key === 'ArrowLeft' && reviewPage > 0) setReviewPage((p) => p - 1);
      if (e.key === 'ArrowRight' && reviewPage < pages.length - 1) setReviewPage((p) => p + 1);
    }

    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [activeTab, reviewPage, pages.length]);

  // OCR via SSE
  function runOCR() {
    if (ocrRunning) return;
    setOcrRunning(true);
    setOcrProgress({ page: 0, total: 0 });
    setError('');

    const es = new EventSource(`/api/texts/${id}/ocr`);

    es.addEventListener('start', (e) => {
      const data = JSON.parse(e.data);
      setOcrProgress({ page: 0, total: data.total });
    });

    es.addEventListener('progress', (e) => {
      const data = JSON.parse(e.data);
      setOcrProgress({ page: data.page, total: data.total });
    });

    es.addEventListener('page-error', (e) => {
      const data = JSON.parse(e.data);
      console.error(`OCR error for ${data.filename}: ${data.error}`);
    });

    es.addEventListener('error', (e) => {
      if (e.data) {
        const data = JSON.parse(e.data);
        setError(data.message || 'OCR error');
      }
      es.close();
      setOcrRunning(false);
    });

    es.addEventListener('complete', (e) => {
      const data = JSON.parse(e.data);
      setToast(`OCR complete: ${data.processed}/${data.total} pages processed.`);
      setTimeout(() => setToast(''), 4000);
      es.close();
      setOcrRunning(false);
      loadText(); // Reload pages with OCR results
    });

    // Handle connection errors
    es.onerror = () => {
      es.close();
      setOcrRunning(false);
      setError('Connection to OCR service lost.');
    };
  }

  // Toolbar actions for Full Text editor
  function insertMarkdown(prefix, suffix = '') {
    const ta = textareaRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const currentText = textLang === 'original' ? fullText : translationText;
    const selected = currentText.substring(start, end);
    const newText = currentText.substring(0, start) + prefix + selected + suffix + currentText.substring(end);
    if (textLang === 'original') {
      setFullText(newText);
    } else {
      setTranslationText(newText);
    }
    // Restore cursor
    setTimeout(() => {
      ta.focus();
      ta.selectionStart = start + prefix.length;
      ta.selectionEnd = start + prefix.length + selected.length;
    }, 0);
  }

  async function saveFullText() {
    setSavingText(true);
    try {
      await api.post(`/api/texts/${id}/save`, { text: fullText });
      setToast('Text saved successfully.');
      setTimeout(() => setToast(''), 3000);
    } catch (err) {
      setError(err.message);
    } finally {
      setSavingText(false);
    }
  }

  async function savePageReview() {
    const visPages = pages.filter((p) => p.filename !== '__compiled__');
    if (!visPages[reviewPage]) return;
    setSavingPage(true);
    try {
      await api.post(`/api/texts/${id}/pages/${visPages[reviewPage].id}`, { text: pageText });
      // Update local state
      const targetId = visPages[reviewPage].id;
      setPages((prev) => prev.map((p) =>
        p.id === targetId ? { ...p, ocr_text: pageText } : p
      ));
      setToast('Page text saved.');
      setTimeout(() => setToast(''), 3000);
    } catch (err) {
      setError(err.message);
    } finally {
      setSavingPage(false);
    }
  }

  // Details handlers
  async function handleGenerateSummary() {
    setGeneratingSummary(true);
    try {
      const data = await api.post(`/api/texts/${id}/summary`);
      setSummary(data.summary);
      setToast('Summary generated.');
      setTimeout(() => setToast(''), 3000);
    } catch (err) {
      setError(err.message);
    } finally {
      setGeneratingSummary(false);
    }
  }

  async function saveSummary() {
    setSavingSummary(true);
    try {
      await api.put(`/api/texts/${id}/summary`, { summary });
      setToast('Summary saved.');
      setTimeout(() => setToast(''), 3000);
    } catch (err) {
      setError(err.message);
    } finally {
      setSavingSummary(false);
    }
  }

  async function handleGenerateTranslation() {
    setGeneratingTranslation(true);
    try {
      const data = await api.post(`/api/texts/${id}/translation`, { targetLanguage: targetLang });
      setTranslation(data.translation);
      setToast('Translation generated.');
      setTimeout(() => setToast(''), 3000);
    } catch (err) {
      setError(err.message);
    } finally {
      setGeneratingTranslation(false);
    }
  }

  async function saveTranslation() {
    setSavingTranslation(true);
    try {
      await api.put(`/api/texts/${id}/translation`, { translation });
      setToast('Translation saved.');
      setTimeout(() => setToast(''), 3000);
    } catch (err) {
      setError(err.message);
    } finally {
      setSavingTranslation(false);
    }
  }

  async function saveMetadata() {
    setSavingMetadata(true);
    try {
      await api.post(`/api/texts/${id}/metadata`, metadata);
      setToast('Metadata saved.');
      setTimeout(() => setToast(''), 3000);
    } catch (err) {
      setError(err.message);
    } finally {
      setSavingMetadata(false);
    }
  }

  // Filter out compiled pages for display
  const visiblePages = pages.filter((p) => p.filename !== '__compiled__');

  if (loading) {
    return (
      <div className="flex justify-center items-center min-h-[60vh]">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-cail-blue"></div>
      </div>
    );
  }

  if (!text) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="p-4 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm">
          Text not found.
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

      {/* Back link */}
      <Link
        to={`/projects/${text.project_id}`}
        className="inline-flex items-center gap-2 text-sm text-gray-500 hover:text-cail-dark mb-4 group"
      >
        <svg className="w-4 h-4 group-hover:-translate-x-0.5 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
        </svg>
        Back to Project
      </Link>

      {error && (
        <div className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm">
          {error}
          <button onClick={() => setError('')} className="ml-2 font-medium hover:underline">Dismiss</button>
        </div>
      )}

      {/* Title */}
      <h1 className="font-display font-semibold text-2xl text-cail-dark mb-4">{text.name}</h1>

      {/* Tabs */}
      <div className="border-b border-gray-200 mb-6">
        <nav className="flex gap-1 -mb-px">
          {TABS.map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab
                  ? 'border-cail-blue text-cail-blue'
                  : 'border-transparent text-gray-500 hover:text-cail-dark hover:border-gray-300'
              }`}
            >
              {tab}
            </button>
          ))}
        </nav>
      </div>

      {/* ============================================================ */}
      {/* PAGES TAB */}
      {/* ============================================================ */}
      {activeTab === 'Pages' && (
        <div>
          <div className="flex items-center gap-4 mb-6">
            <button
              onClick={runOCR}
              disabled={ocrRunning || visiblePages.length === 0}
              className="px-6 py-2.5 rounded-full bg-cail-blue text-white text-sm font-medium hover:bg-cail-navy transition-colors disabled:opacity-50"
            >
              {ocrRunning ? 'Running OCR...' : 'Run OCR'}
            </button>
            <span className="text-sm text-gray-500">
              {visiblePages.length} page{visiblePages.length !== 1 ? 's' : ''}
            </span>
          </div>

          {/* OCR Progress */}
          {ocrRunning && ocrProgress.total > 0 && (
            <div className="mb-6 bg-white rounded-2xl border border-gray-100 p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-gray-600">OCR Progress</span>
                <span className="text-sm text-gray-500">
                  {ocrProgress.page}/{ocrProgress.total}
                </span>
              </div>
              <div className="w-full bg-gray-100 rounded-full h-2">
                <div
                  className="h-2 rounded-full bg-cail-teal transition-all"
                  style={{ width: `${(ocrProgress.page / ocrProgress.total) * 100}%` }}
                />
              </div>
            </div>
          )}

          {/* Thumbnail grid */}
          {visiblePages.length === 0 ? (
            <div className="text-center py-12 bg-white rounded-2xl border border-gray-100">
              <p className="text-sm text-gray-500">No pages uploaded yet. Upload images from the project view.</p>
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
              {visiblePages.map((page, idx) => (
                <div
                  key={page.id || idx}
                  className="relative bg-white rounded-xl border border-gray-100 overflow-hidden group hover:shadow-md transition-shadow"
                >
                  <div className="aspect-[3/4] bg-gray-50">
                    <img
                      src={`/api/texts/${id}/image/${page.filename}?w=200`}
                      alt={`Page ${idx + 1}`}
                      className="w-full h-full object-cover"
                      loading="lazy"
                    />
                  </div>
                  <div className="p-2 flex items-center justify-between">
                    <span className="text-xs text-gray-500">Page {idx + 1}</span>
                    {page.ocr_text ? (
                      <svg className="w-4 h-4 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                    ) : (
                      <span className="w-2 h-2 rounded-full bg-gray-300"></span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ============================================================ */}
      {/* FULL TEXT TAB */}
      {/* ============================================================ */}
      {activeTab === 'Full Text' && (
        <div>
          {/* Toolbar */}
          <div className="flex items-center gap-2 mb-4 flex-wrap">
            <div className="flex items-center gap-1 bg-white rounded-lg border border-gray-200 p-1">
              <button
                onClick={() => insertMarkdown('**', '**')}
                className="px-3 py-1.5 rounded text-sm font-bold text-gray-600 hover:bg-gray-100 transition-colors"
                title="Bold"
              >
                B
              </button>
              <button
                onClick={() => insertMarkdown('*', '*')}
                className="px-3 py-1.5 rounded text-sm italic text-gray-600 hover:bg-gray-100 transition-colors"
                title="Italic"
              >
                I
              </button>
              <button
                onClick={() => insertMarkdown('## ')}
                className="px-3 py-1.5 rounded text-sm font-medium text-gray-600 hover:bg-gray-100 transition-colors"
                title="Heading"
              >
                H
              </button>
              <button
                onClick={() => insertMarkdown('\n\n---\n\n')}
                className="px-3 py-1.5 rounded text-sm text-gray-600 hover:bg-gray-100 transition-colors"
                title="Separator"
              >
                --
              </button>
            </div>

            <select
              value={textLang}
              onChange={(e) => setTextLang(e.target.value)}
              className="text-sm px-3 py-1.5 rounded-lg border border-gray-200 focus:border-cail-blue outline-none"
            >
              <option value="original">Original</option>
              <option value="translation">Translation</option>
            </select>

            <button
              onClick={() => setShowPreview(!showPreview)}
              className={`px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${
                showPreview ? 'bg-cail-blue text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              {showPreview ? 'Edit' : 'Preview'}
            </button>

            <button
              onClick={saveFullText}
              disabled={savingText}
              className="px-4 py-1.5 rounded-full bg-cail-blue text-white text-sm font-medium hover:bg-cail-navy transition-colors disabled:opacity-50 ml-auto"
            >
              {savingText ? 'Saving...' : 'Save'}
            </button>
          </div>

          {/* Editor / Preview */}
          {showPreview ? (
            <div
              className="bg-white rounded-2xl border border-gray-100 p-6 prose prose-sm max-w-none min-h-[400px]"
              dangerouslySetInnerHTML={{
                __html: renderSanitizedMarkdown(textLang === 'original' ? fullText : translationText)
              }}
            />
          ) : (
            <textarea
              ref={textareaRef}
              value={textLang === 'original' ? fullText : translationText}
              onChange={(e) => {
                if (textLang === 'original') {
                  setFullText(e.target.value);
                } else {
                  setTranslationText(e.target.value);
                }
              }}
              className="w-full min-h-[400px] px-4 py-3 rounded-2xl border border-gray-200 focus:border-cail-blue focus:ring-2 focus:ring-cail-blue/20 outline-none transition text-sm font-mono resize-y bg-white"
              placeholder="OCR text will appear here after processing..."
            />
          )}
        </div>
      )}

      {/* ============================================================ */}
      {/* REVIEW TAB */}
      {/* ============================================================ */}
      {activeTab === 'Review' && (
        <div>
          {visiblePages.length === 0 ? (
            <div className="text-center py-12 bg-white rounded-2xl border border-gray-100">
              <p className="text-sm text-gray-500">No pages to review.</p>
            </div>
          ) : (
            <>
              {/* Page navigation */}
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setReviewPage((p) => Math.max(0, p - 1))}
                    disabled={reviewPage === 0}
                    className="p-2 rounded-lg border border-gray-200 hover:bg-gray-50 disabled:opacity-30 transition-colors"
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                    </svg>
                  </button>
                  <span className="text-sm text-gray-600 min-w-[80px] text-center">
                    Page {reviewPage + 1} of {visiblePages.length}
                  </span>
                  <button
                    onClick={() => setReviewPage((p) => Math.min(visiblePages.length - 1, p + 1))}
                    disabled={reviewPage >= visiblePages.length - 1}
                    className="p-2 rounded-lg border border-gray-200 hover:bg-gray-50 disabled:opacity-30 transition-colors"
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                  </button>
                </div>
                <button
                  onClick={savePageReview}
                  disabled={savingPage}
                  className="px-4 py-1.5 rounded-full bg-cail-blue text-white text-sm font-medium hover:bg-cail-navy transition-colors disabled:opacity-50"
                >
                  {savingPage ? 'Saving...' : 'Save Page'}
                </button>
              </div>

              {/* Side-by-side layout */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4" style={{ height: '65vh' }}>
                {/* Image */}
                <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden flex items-center justify-center">
                  {visiblePages[reviewPage] && (
                    <img
                      src={`/api/texts/${id}/image/${visiblePages[reviewPage].filename}`}
                      alt={`Page ${reviewPage + 1}`}
                      className="max-w-full max-h-full object-contain"
                    />
                  )}
                </div>

                {/* Text editor */}
                <textarea
                  value={pageText}
                  onChange={(e) => setPageText(e.target.value)}
                  className="w-full h-full px-4 py-3 rounded-2xl border border-gray-200 focus:border-cail-blue focus:ring-2 focus:ring-cail-blue/20 outline-none transition text-sm font-mono resize-none bg-white"
                  placeholder="OCR text for this page..."
                />
              </div>
            </>
          )}
        </div>
      )}

      {/* ============================================================ */}
      {/* DETAILS TAB */}
      {/* ============================================================ */}
      {activeTab === 'Details' && (
        <div className="space-y-8">
          {/* Summary section */}
          <div className="bg-white rounded-2xl border border-gray-100 p-6">
            <h3 className="font-display font-semibold text-lg text-cail-dark mb-4">Summary</h3>
            <textarea
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              rows={4}
              className="w-full px-4 py-3 rounded-xl border border-gray-200 focus:border-cail-blue focus:ring-2 focus:ring-cail-blue/20 outline-none transition text-sm resize-y"
              placeholder="Summary of this text..."
            />
            <div className="flex items-center gap-3 mt-3">
              <button
                onClick={handleGenerateSummary}
                disabled={generatingSummary}
                className="px-4 py-2 rounded-full bg-cail-teal text-white text-sm font-medium hover:bg-cail-azure transition-colors disabled:opacity-50"
              >
                {generatingSummary ? 'Generating...' : 'Generate with AI'}
              </button>
              <button
                onClick={saveSummary}
                disabled={savingSummary}
                className="px-4 py-2 rounded-full bg-cail-blue text-white text-sm font-medium hover:bg-cail-navy transition-colors disabled:opacity-50"
              >
                {savingSummary ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>

          {/* Translation section */}
          <div className="bg-white rounded-2xl border border-gray-100 p-6">
            <h3 className="font-display font-semibold text-lg text-cail-dark mb-4">Translation</h3>
            <div className="mb-3">
              <label className="block text-sm font-medium text-gray-700 mb-1">Target Language</label>
              <select
                value={targetLang}
                onChange={(e) => setTargetLang(e.target.value)}
                className="text-sm px-3 py-2 rounded-lg border border-gray-200 focus:border-cail-blue outline-none"
              >
                {LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code}>{l.label}</option>
                ))}
              </select>
            </div>
            <textarea
              value={translation}
              onChange={(e) => setTranslation(e.target.value)}
              rows={4}
              className="w-full px-4 py-3 rounded-xl border border-gray-200 focus:border-cail-blue focus:ring-2 focus:ring-cail-blue/20 outline-none transition text-sm resize-y"
              placeholder="Translation will appear here..."
            />
            <div className="flex items-center gap-3 mt-3">
              <button
                onClick={handleGenerateTranslation}
                disabled={generatingTranslation}
                className="px-4 py-2 rounded-full bg-cail-teal text-white text-sm font-medium hover:bg-cail-azure transition-colors disabled:opacity-50"
              >
                {generatingTranslation ? 'Generating...' : 'Generate with AI'}
              </button>
              <button
                onClick={saveTranslation}
                disabled={savingTranslation}
                className="px-4 py-2 rounded-full bg-cail-blue text-white text-sm font-medium hover:bg-cail-navy transition-colors disabled:opacity-50"
              >
                {savingTranslation ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>

          {/* Dublin Core Metadata */}
          <div className="bg-white rounded-2xl border border-gray-100 p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-display font-semibold text-lg text-cail-dark">Dublin Core Metadata</h3>
              <button
                onClick={saveMetadata}
                disabled={savingMetadata}
                className="px-4 py-2 rounded-full bg-cail-blue text-white text-sm font-medium hover:bg-cail-navy transition-colors disabled:opacity-50"
              >
                {savingMetadata ? 'Saving...' : 'Save Metadata'}
              </button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {DC_FIELDS.map((field) => (
                <div key={field.key}>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    {field.label}
                  </label>
                  <input
                    type="text"
                    value={metadata[field.key] || ''}
                    onChange={(e) => setMetadata((m) => ({ ...m, [field.key]: e.target.value }))}
                    className="w-full px-3 py-2 rounded-lg border border-gray-200 focus:border-cail-blue outline-none text-sm"
                  />
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
