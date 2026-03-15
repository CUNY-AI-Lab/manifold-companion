import { useState, useEffect, useRef } from 'react';
import { useParams, useSearchParams, Link } from 'react-router-dom';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { api, BASE } from '../api/client';
import VersionHistory from '../components/VersionHistory';
import AnnotationSidebar from '../components/AnnotationSidebar';
import KeyboardShortcuts from '../components/KeyboardShortcuts';
import useUnsavedChanges from '../hooks/useUnsavedChanges';
import useHotkeys from '../hooks/useHotkeys';

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

const TABS = ['Pages', 'Full Text', 'Review', 'Translation', 'Details'];

const OCR_PRESETS = [
  { key: '', label: 'Custom / No preset' },
  {
    key: 'general',
    label: 'General (Default)',
    prompt: `You are an expert OCR system. This is a scan of a document page.

CRITICAL INSTRUCTIONS:
- The paper may be thin, so you may see faint text bleeding through from the OTHER SIDE. IGNORE reversed/mirrored or faint bleed-through text. Only transcribe the main text on THIS side.
- Transcribe the text EXACTLY as written, preserving the original language.
- The text may wrap at fixed margins. Do NOT preserve physical line breaks. Join lines in the same paragraph into continuous text. Only break where there is an actual paragraph break.
- Do NOT include page numbers.
- Do NOT add any commentary, headers, or footers.
- Do NOT repeat any text. If you have already transcribed a section, do not transcribe it again. Each paragraph should appear exactly once.

HANDLING UNCLEAR OR MODIFIED TEXT:
- Hard to read: [unclear: your best guess]
- Crossed out: [deleted: crossed out text]
- Handwritten annotations: [handwritten: the annotation text]
- Completely illegible: [illegible]

MARKDOWN FORMATTING:
- ## Heading for titles, centered headings, section headers
- **bold** for emphasized words or character names
- *italic* for stage directions, handwritten annotations, italic typeface
- --- for section separators
- Regular body text: no formatting

Output ONLY the transcribed text. No thinking or reasoning.`,
  },
  {
    key: 'typewriter',
    label: 'Typewriter Manuscript',
    prompt: `You are an expert OCR system. This is a scan of a typewritten manuscript page.

CRITICAL INSTRUCTIONS:
- The paper is very thin, so you may see faint text bleeding through from the OTHER SIDE of the page. IGNORE any reversed/mirrored or faint bleed-through text completely. Only transcribe the main text on THIS side of the page.
- Transcribe the text EXACTLY as written, preserving the original language.
- IMPORTANT: The typewriter wraps lines at a fixed margin. Do NOT preserve these physical line breaks. Join lines that belong to the same paragraph into flowing continuous text. Only insert a line break where there is an actual paragraph break (a blank line, a clear topic/scene change, or dialogue formatting).
- Do NOT include page numbers.
- Do NOT add any commentary, headers, or footers.
- Do NOT repeat any text. Each paragraph should appear exactly once.
- Typewriter characters may be uneven or faded — use context to infer ambiguous letters (e.g., distinguishing l/1, O/0, rn/m).
- Preserve any consistent spelling variations or idiosyncrasies of the typist.

HANDLING UNCLEAR OR MODIFIED TEXT:
- If a word or phrase is genuinely hard to read, include your best guess and flag it: [unclear: your best guess]
- If text has been crossed out or struck through, transcribe it with a flag: [deleted: crossed out text]
- If there are handwritten annotations, corrections, or marginal notes alongside the typed text, transcribe them with a flag: [handwritten: the annotation text]
- If handwritten text replaces or corrects typed text, indicate both: [deleted: original text] [handwritten: replacement text]
- If something is completely impossible to decipher, use: [illegible]

MARKDOWN FORMATTING:
- ## Heading for titles, centered headings, section headers
- **bold** for emphasized words or character names
- *italic* for stage directions, handwritten annotations, italic typeface
- --- for section separators
- Do NOT over-format: regular body paragraphs should remain plain text with no formatting
- When in doubt, leave text unformatted — false negatives are better than false positives

Output ONLY the transcribed text with the flags and markdown formatting described above, nothing else. No thinking or reasoning.`,
  },
  {
    key: 'handwritten',
    label: 'Handwritten Document',
    prompt: `You are an expert OCR system specialized in handwriting recognition. This is a scan of a handwritten document page.

CRITICAL INSTRUCTIONS:
- The paper may be thin, so you may see faint text bleeding through from the OTHER SIDE. IGNORE reversed/mirrored or faint bleed-through text. Only transcribe the main text on THIS side.
- Transcribe the text EXACTLY as written, preserving the original language, spelling, and punctuation.
- Handwriting varies in legibility — use context (surrounding words, sentence structure, topic) to infer unclear letters and words.
- Join lines that belong to the same paragraph into flowing text. Only break where there is a clear paragraph change.
- Do NOT include page numbers.
- Do NOT add any commentary, headers, or footers.
- Do NOT repeat any text. Each paragraph should appear exactly once.
- Pay attention to:
  - Words that may be connected by cursive strokes
  - Letters that look similar in the writer's hand (e.g., a/o, u/v, n/m, e/i)
  - Abbreviations or shorthand the writer may use consistently
  - Diacritical marks and accents

HANDLING UNCLEAR TEXT:
- Hard to read: [unclear: your best guess]
- Crossed out or struck through: [deleted: crossed out text]
- Inserted text (carets, arrows, marginal additions): [inserted: added text]
- Completely illegible: [illegible]

MARKDOWN FORMATTING:
- ## Heading for titles or section headers
- **bold** for underlined or heavily emphasized words
- *italic* for words written in a noticeably different hand or style
- --- for section separators or horizontal rules drawn by the writer
- Regular body text: no formatting

Output ONLY the transcribed text. No thinking or reasoning.`,
  },
  {
    key: 'printed-book',
    label: 'Printed Book',
    prompt: `You are an expert OCR system. This is a scan of a page from a printed book.

CRITICAL INSTRUCTIONS:
- Transcribe the text EXACTLY as printed, preserving the original language and orthography.
- Join lines within the same paragraph into flowing text. Do NOT preserve line breaks caused by the page column width.
- Handle hyphenated words at line breaks: rejoin them (e.g., "com-\nputer" → "computer").
- Do NOT include:
  - Page numbers
  - Running headers or footers (repeating book title, chapter name, or author name at top/bottom)
  - Library stamps, catalog markings, or other non-original annotations
- Do NOT repeat any text. Each paragraph should appear exactly once.
- Preserve paragraph indentation as paragraph breaks.
- For older printed books, preserve historical spellings exactly as printed (e.g., "colour", "connexion", long-s "ſ").

HANDLING SPECIAL ELEMENTS:
- Footnotes: transcribe at the bottom, prefixed with the footnote marker (e.g., "¹ Footnote text here.")
- Illustrations or figures: [illustration: brief description]
- Tables: preserve structure using markdown table syntax
- Damaged or obscured text: [unclear: your best guess] or [illegible]

MARKDOWN FORMATTING:
- # for chapter titles
- ## for section headings
- **bold** for bold text
- *italic* for italic text
- > for block quotes or epigraphs
- --- for section breaks or ornamental dividers
- Regular body text: no formatting

Output ONLY the transcribed text. No thinking or reasoning.`,
  },
  {
    key: 'historical',
    label: 'Historical / Damaged Document',
    prompt: `You are an expert OCR system specialized in historical documents. This is a scan of an aged or potentially damaged document page.

CRITICAL INSTRUCTIONS:
- Transcribe the text EXACTLY as written, preserving the original language, spelling, and orthography even if archaic.
- The document may have stains, tears, fading, foxing, or other damage. Use context and surrounding text to infer words in damaged areas.
- The paper may be thin, so you may see bleed-through. IGNORE reversed/mirrored or faint bleed-through text.
- Join lines in the same paragraph into flowing text. Only break where there is an actual paragraph break.
- Do NOT modernize spelling, punctuation, or grammar.
- Do NOT include page numbers.
- Do NOT add any commentary, headers, or footers.
- Do NOT repeat any text. Each paragraph should appear exactly once.
- Preserve:
  - Historical letter forms (e.g., long-s "ſ", thorn "þ", eth "ð")
  - Abbreviation marks and contractions as they appear
  - Original capitalization and punctuation conventions

HANDLING UNCLEAR OR DAMAGED TEXT:
- Partially legible (can guess): [unclear: your best guess]
- Damaged but partially visible: [damaged: visible portions]
- Completely lost (torn, stained beyond reading): [illegible]
- Crossed out or struck through: [deleted: crossed out text]
- Later annotations in a different hand: [annotation: text]

MARKDOWN FORMATTING:
- ## Heading for titles, section headers
- **bold** for emphasized or decorated text
- *italic* for text in a different script or hand
- --- for section separators
- Regular body text: no formatting

Output ONLY the transcribed text. No thinking or reasoning.`,
  },
  {
    key: 'multilingual',
    label: 'Multilingual / Mixed Script',
    prompt: `You are an expert OCR system with multilingual capabilities. This is a scan of a document that may contain multiple languages or writing systems.

CRITICAL INSTRUCTIONS:
- Transcribe the text EXACTLY as written, preserving ALL languages and scripts present on the page.
- Do not translate between languages. Reproduce each language in its original script.
- The paper may be thin, so you may see bleed-through. IGNORE reversed/mirrored or faint bleed-through text.
- Join lines in the same paragraph into flowing text. Only break where there is an actual paragraph break.
- Do NOT include page numbers.
- Do NOT add any commentary, headers, or footers.
- Do NOT repeat any text. Each paragraph should appear exactly once.
- Pay careful attention to:
  - Language switches within the same paragraph or sentence
  - Diacritical marks, accents, and special characters for each language
  - Right-to-left scripts (Arabic, Hebrew) — transcribe in the correct reading order
  - Non-Latin scripts (Greek, Cyrillic, CJK, Devanagari, etc.) — reproduce accurately

HANDLING UNCLEAR TEXT:
- Hard to read: [unclear: your best guess]
- Crossed out: [deleted: crossed out text]
- Handwritten annotations: [handwritten: the annotation text]
- Completely illegible: [illegible]

MARKDOWN FORMATTING:
- ## Heading for titles, section headers
- **bold** for emphasized words
- *italic* for foreign-language glosses, transliterations, or italic text
- --- for section separators
- Regular body text: no formatting

Output ONLY the transcribed text. No thinking or reasoning.`,
  },
];

/**
 * Safely render markdown to sanitized HTML.
 * All output is sanitized through DOMPurify to prevent XSS.
 */
function renderSanitizedMarkdown(md) {
  const rawHtml = marked.parse(md || '');
  return DOMPurify.sanitize(rawHtml);
}

export default function TextDetail() {
  const { id } = useParams();
  const [searchParams] = useSearchParams();

  const [text, setText] = useState(null);
  const [pages, setPages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [activeTab, setActiveTab] = useState(() => {
    const tab = searchParams.get('tab');
    return TABS.includes(tab) ? tab : 'Pages';
  });

  // Upload state
  const fileInputRef = useRef(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState('');
  const [uploadSuccess, setUploadSuccess] = useState('');
  const [showUploadZone, setShowUploadZone] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  // Drag reorder state
  const [reorderMode, setReorderMode] = useState(false);
  const [dragIdx, setDragIdx] = useState(null);
  const [dragOverIdx, setDragOverIdx] = useState(null);

  // OCR state
  const [ocrRunning, setOcrRunning] = useState(false);
  const [ocrProgress, setOcrProgress] = useState({ page: 0, total: 0 });

  // Full Text state
  const [fullText, setFullText] = useState('');
  const [copySuccess, setCopySuccess] = useState(false);

  // Review state
  const [reviewPage, setReviewPage] = useState(0);
  const [pageText, setPageText] = useState('');
  const [savingPage, setSavingPage] = useState(false);
  const reviewTextareaRef = useRef(null);
  const [reviewZoom, setReviewZoom] = useState(1);
  const [reviewPan, setReviewPan] = useState({ x: 0, y: 0 });
  const [reviewDragging, setReviewDragging] = useState(false);
  const reviewDragStart = useRef({ x: 0, y: 0, panX: 0, panY: 0 });

  // Translation state
  const [translation, setTranslation] = useState('');
  const [targetLang, setTargetLang] = useState('en');
  const [generatingTranslation, setGeneratingTranslation] = useState(false);
  const [savingTranslation, setSavingTranslation] = useState(false);
  const [translationSideBySide, setTranslationSideBySide] = useState(false);

  // Details state
  const [summary, setSummary] = useState('');
  const [metadata, setMetadata] = useState({});
  const [generatingSummary, setGeneratingSummary] = useState(false);
  const [savingSummary, setSavingSummary] = useState(false);
  const [savingMetadata, setSavingMetadata] = useState(false);

  // Lightbox state
  const [lightboxPage, setLightboxPage] = useState(null);
  const [lbZoom, setLbZoom] = useState(1);
  const [lbPan, setLbPan] = useState({ x: 0, y: 0 });
  const [lbDragging, setLbDragging] = useState(false);
  const lbDragStart = useRef({ x: 0, y: 0, panX: 0, panY: 0 });

  // Collaboration state
  const [role, setRole] = useState('viewer');
  const [showVersions, setShowVersions] = useState(false);
  const [showAnnotations, setShowAnnotations] = useState(() => searchParams.get('annotations') === '1');
  const [showShortcuts, setShowShortcuts] = useState(false);

  // OCR Settings modal state
  const [showOcrSettings, setShowOcrSettings] = useState(false);
  const [ocrSettings, setOcrSettings] = useState({
    prompt: '',
    model: '',
    temperature: 0.1,
    max_tokens: 8192,
  });
  const [savingSettings, setSavingSettings] = useState(false);

  // Load text data
  useEffect(() => {
    loadText();
  }, [id]);

  async function loadText() {
    try {
      const data = await api.get(`/api/texts/${id}`);
      setText(data);
      setPages(data.pages || []);
      setRole(data.role || 'viewer');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  // File upload
  async function processAndUpload(files) {
    setUploading(true);
    setUploadProgress('Processing files...');
    setUploadSuccess('');
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

        await api.upload(`/api/texts/${id}/upload`, formData);
        totalUploaded += batch.length;
      }

      setUploadSuccess(`${totalUploaded} image${totalUploaded !== 1 ? 's' : ''} uploaded`);
      setShowUploadZone(false);
      setToast(`Uploaded ${totalUploaded} image(s) successfully.`);
      setTimeout(() => setToast(''), 3000);
      await loadText();
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
      setUploadProgress('');
    }
  }

  function handleFileSelect(e) {
    const files = Array.from(e.target.files || []);
    if (files.length > 0) processAndUpload(files);
    e.target.value = '';
  }

  function handleDrop(e) {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files || []);
    if (files.length > 0) processAndUpload(files);
  }

  // Lightbox helpers
  function lbResetView() { setLbZoom(1); setLbPan({ x: 0, y: 0 }); }

  function lbGoTo(idx) {
    setLightboxPage(idx);
    lbResetView();
  }

  function lbHandleWheel(e) {
    e.stopPropagation();
    const delta = e.deltaY > 0 ? -0.25 : 0.25;
    setLbZoom((z) => {
      const next = Math.min(5, Math.max(0.5, z + delta));
      if (next <= 1) setLbPan({ x: 0, y: 0 });
      return next;
    });
  }

  function lbMouseDown(e) {
    if (lbZoom <= 1) return;
    e.preventDefault();
    setLbDragging(true);
    lbDragStart.current = { x: e.clientX, y: e.clientY, panX: lbPan.x, panY: lbPan.y };
  }

  function lbMouseMove(e) {
    if (!lbDragging) return;
    setLbPan({
      x: lbDragStart.current.panX + (e.clientX - lbDragStart.current.x),
      y: lbDragStart.current.panY + (e.clientY - lbDragStart.current.y),
    });
  }

  function lbMouseUp() { setLbDragging(false); }

  // Page reorder via drag-and-drop
  async function handleReorderDrop(fromIdx, toIdx) {
    if (fromIdx === toIdx) return;
    const reordered = [...visiblePages];
    const [moved] = reordered.splice(fromIdx, 1);
    reordered.splice(toIdx, 0, moved);

    // Optimistic update
    const allPages = pages.filter((p) => p.filename === '__compiled__');
    setPages([...reordered, ...allPages]);

    try {
      await api.put(`/api/texts/${id}/pages/reorder`, {
        pageIds: reordered.map((p) => p.id),
      });
    } catch (err) {
      setError(err.message);
      loadText(); // Revert on failure
    }
  }

  // Load full text when switching to Full Text or Translation tab
  useEffect(() => {
    if (activeTab === 'Full Text' || activeTab === 'Translation') {
      loadFullText();
    }
  }, [activeTab, id]);

  async function loadFullText() {
    try {
      const data = await api.get(`/api/texts/${id}/result`);
      setFullText(data.text || '');
    } catch (err) {
      // Ignore -- may not have text yet
    }
  }

  // Load translation data when switching to Translation tab
  useEffect(() => {
    if (activeTab === 'Translation') {
      loadTranslation();
    }
  }, [activeTab, id]);

  async function loadTranslation() {
    try {
      const transData = await api.get(`/api/texts/${id}/translation`);
      setTranslation(transData.translation || '');
      setTargetLang(transData.target_language || 'en');
    } catch (err) {
      // Ignore
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
      const [summaryData, metaData] = await Promise.all([
        api.get(`/api/texts/${id}/summary`),
        api.get(`/api/texts/${id}/metadata`),
      ]);
      setSummary(summaryData.summary || '');
      setMetadata(metaData || {});
    } catch (err) {
      // Ignore errors for missing data
    }
  }

  // Filter out compiled pages for display
  const visiblePages = pages.filter((p) => p.filename !== '__compiled__');

  const currentPageId = visiblePages[reviewPage]?.id;
  const { isDirty: hasUnsaved, draftBanner, dismissDraft, restoreDraft, markSaved } = useUnsavedChanges(
    currentPageId ? `mc-draft-${id}-page-${currentPageId}` : null,
    pageText,
    text?.updated_at,
    { enabled: activeTab === 'Review' }
  );

  // MD Editor shortcuts
  useHotkeys({
    'Cmd+S': { handler: () => savePageReview(), label: 'Save page', section: 'MD Editor', allowInEditable: true },
    'Cmd+Shift+S': { handler: () => { savePageReview(); if (reviewPage < visiblePages.length - 1) setReviewPage(p => p + 1); }, label: 'Save and next page', section: 'MD Editor', allowInEditable: true },
  }, { when: activeTab === 'Review' && role !== 'viewer' });

  // Page navigation (arrow keys should NOT work in editable targets - default behavior)
  useHotkeys({
    'ArrowLeft': { handler: () => { if (reviewPage > 0) setReviewPage(p => p - 1); }, label: 'Previous page', section: 'MD Editor' },
    'ArrowRight': { handler: () => { if (reviewPage < visiblePages.length - 1) setReviewPage(p => p + 1); }, label: 'Next page', section: 'MD Editor' },
  }, { when: activeTab === 'Review' });

  // Navigation shortcuts
  useHotkeys({
    'Cmd+Shift+C': { handler: () => setShowAnnotations(s => !s), label: 'Toggle comments', section: 'Navigation' },
    'Cmd+Shift+H': { handler: () => setShowVersions(s => !s), label: 'Version history', section: 'Navigation' },
    'Alt+ArrowLeft': { handler: () => { const idx = TABS.indexOf(activeTab); if (idx > 0) setActiveTab(TABS[idx - 1]); }, label: 'Previous tab', section: 'Navigation' },
    'Alt+ArrowRight': { handler: () => { const idx = TABS.indexOf(activeTab); if (idx < TABS.length - 1) setActiveTab(TABS[idx + 1]); }, label: 'Next tab', section: 'Navigation' },
    'Escape': { handler: () => { if (showShortcuts) setShowShortcuts(false); else if (showAnnotations) setShowAnnotations(false); else if (showVersions) setShowVersions(false); }, label: 'Close panel', section: 'General' },
    '?': { handler: () => setShowShortcuts(s => !s), label: 'Keyboard shortcuts', section: 'General' },
    'Cmd+/': { handler: () => setShowShortcuts(s => !s), label: 'Keyboard shortcuts', section: 'General', allowInEditable: true },
  }, { when: true });

  // Keyboard navigation for lightbox
  useEffect(() => {
    if (lightboxPage === null) return;
    function onKey(e) {
      if (e.key === 'Escape') { setLightboxPage(null); lbResetView(); }
      else if (e.key === 'ArrowLeft' && lightboxPage > 0) lbGoTo(lightboxPage - 1);
      else if (e.key === 'ArrowRight' && lightboxPage < visiblePages.length - 1) lbGoTo(lightboxPage + 1);
      else if (e.key === '+' || e.key === '=') setLbZoom((z) => Math.min(5, z + 0.25));
      else if (e.key === '-') {
        setLbZoom((z) => {
          const next = Math.max(0.5, z - 0.25);
          if (next <= 1) setLbPan({ x: 0, y: 0 });
          return next;
        });
      }
      else if (e.key === '0') lbResetView();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightboxPage, visiblePages.length]);

  // Load page text for review
  useEffect(() => {
    if (activeTab === 'Review' && visiblePages.length > 0 && visiblePages[reviewPage]) {
      setPageText(visiblePages[reviewPage].ocr_text || '');
      setReviewZoom(1);
      setReviewPan({ x: 0, y: 0 });
    }
  }, [activeTab, reviewPage, pages]);

  // OCR via SSE — with confirmation dialog (Task 1)
  function runOCR() {
    if (ocrRunning) return;

    // Check if any pages already have OCR text
    const pagesWithOcr = visiblePages.filter((p) => p.ocr_text);
    if (pagesWithOcr.length > 0) {
      if (!window.confirm(
        `${pagesWithOcr.length} page(s) already have OCR results. Re-running will overwrite them. Continue?`
      )) {
        return;
      }
    }

    setOcrRunning(true);
    setOcrProgress({ page: 0, total: 0 });
    setError('');

    const es = new EventSource(`${BASE}/api/texts/${id}/ocr`);

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
      loadText();
    });

    es.onerror = () => {
      es.close();
      setOcrRunning(false);
      setError('Connection to OCR service lost.');
    };
  }

  // Review markdown toolbar (Task 5)
  function insertReviewMarkdown(prefix, suffix = '') {
    const ta = reviewTextareaRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const selected = pageText.substring(start, end);
    const newText = pageText.substring(0, start) + prefix + selected + suffix + pageText.substring(end);
    setPageText(newText);
    setTimeout(() => {
      ta.focus();
      ta.selectionStart = start + prefix.length;
      ta.selectionEnd = start + prefix.length + selected.length;
    }, 0);
  }

  async function savePageReview() {
    if (!visiblePages[reviewPage]) return;
    setSavingPage(true);
    try {
      await api.post(`/api/texts/${id}/pages/${visiblePages[reviewPage].id}`, { text: pageText });
      const targetId = visiblePages[reviewPage].id;
      setPages((prev) => prev.map((p) =>
        p.id === targetId ? { ...p, ocr_text: pageText } : p
      ));
      setToast('Page text saved.');
      markSaved(pageText);
      setTimeout(() => setToast(''), 3000);
    } catch (err) {
      setError(err.message);
    } finally {
      setSavingPage(false);
    }
  }

  // Page deletion (Task 2)
  async function handleDeletePage(pageId) {
    if (!window.confirm('Delete this page? This cannot be undone.')) return;
    try {
      await api.del(`/api/texts/${id}/pages/${pageId}`);
      setToast('Page deleted.');
      setTimeout(() => setToast(''), 3000);
      loadText();
    } catch (err) {
      setError(err.message);
    }
  }

  // Copy full text to clipboard (Task 7)
  async function copyFullText() {
    try {
      await navigator.clipboard.writeText(fullText);
      setCopySuccess(true);
      setTimeout(() => setCopySuccess(false), 2000);
    } catch {
      setError('Failed to copy text.');
    }
  }

  // Translation handlers
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

  // Summary handlers
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

  // OCR Settings handlers (Task 11)
  async function openOcrSettings() {
    setShowOcrSettings(true);
    try {
      const settings = await api.get(`/api/texts/${id}/settings`);
      setOcrSettings({
        prompt: settings.prompt || '',
        model: settings.model || '',
        temperature: settings.temperature ?? 0.1,
        max_tokens: settings.max_tokens || 8192,
      });
    } catch {
      setOcrSettings({ prompt: '', model: '', temperature: 0.1, max_tokens: 8192 });
    }
  }

  async function saveOcrSettings() {
    setSavingSettings(true);
    try {
      await api.post(`/api/texts/${id}/settings`, ocrSettings);
      setToast('OCR settings saved.');
      setTimeout(() => setToast(''), 3000);
      setShowOcrSettings(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setSavingSettings(false);
    }
  }

  async function resetOcrSettings() {
    try {
      await api.del(`/api/texts/${id}/settings`);
      setOcrSettings({ prompt: '', model: '', temperature: 0.1, max_tokens: 8192 });
      setToast('Settings reset to defaults.');
      setTimeout(() => setToast(''), 3000);
    } catch (err) {
      setError(err.message);
    }
  }

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
        <div className="p-4 rounded-lg bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 text-sm">
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
        className="inline-flex items-center gap-2 text-sm text-gray-500 hover:text-cail-dark dark:hover:text-slate-200 mb-4 group"
      >
        <svg className="w-4 h-4 group-hover:-translate-x-0.5 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
        </svg>
        Back to Project
      </Link>

      {error && (
        <div className="mb-4 p-3 rounded-lg bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 text-sm">
          {error}
          <button onClick={() => setError('')} className="ml-2 font-medium hover:underline">Dismiss</button>
        </div>
      )}

      {/* Title */}
      <div className="flex items-center gap-3 mb-4">
        <h1 className="font-display font-semibold text-2xl text-cail-dark dark:text-slate-200">{text.name}</h1>
        {role === 'viewer' && (
          <span className="px-2 py-0.5 rounded-full bg-gray-100 dark:bg-slate-700 text-gray-500 dark:text-slate-400 text-xs font-medium">Read-only</span>
        )}
      </div>

      {/* Tabs */}
      <div className="border-b border-gray-200 dark:border-slate-700 mb-6">
        <nav role="tablist" aria-label="Editor tabs" className="flex gap-1 -mb-px overflow-x-auto">
          {TABS.map((tab) => (
            <button
              key={tab}
              role="tab"
              aria-selected={activeTab === tab}
              aria-controls={`tabpanel-${tab.toLowerCase().replace(/\s+/g, '-')}`}
              id={`tab-${tab.toLowerCase().replace(/\s+/g, '-')}`}
              onClick={() => {
                if (hasUnsaved && activeTab === 'Review' && tab !== 'Review') {
                  if (!window.confirm('You have unsaved changes. Switch tabs anyway?')) return;
                }
                setActiveTab(tab);
              }}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                activeTab === tab
                  ? 'border-cail-blue text-cail-blue'
                  : 'border-transparent text-gray-500 hover:text-cail-dark dark:hover:text-slate-200 hover:border-gray-300 dark:border-slate-600'
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
        <div role="tabpanel" id={`tabpanel-${activeTab.toLowerCase().replace(/\s+/g, '-')}`} aria-labelledby={`tab-${activeTab.toLowerCase().replace(/\s+/g, '-')}`} tabIndex={0}>
          <div className="flex items-center gap-4 mb-6">
            {role !== 'viewer' && (
              <>
                <button
                  onClick={runOCR}
                  disabled={ocrRunning || visiblePages.length === 0}
                  className="px-6 py-2.5 rounded-full bg-cail-blue text-white text-sm font-medium hover:bg-cail-navy transition-colors disabled:opacity-50"
                >
                  {ocrRunning ? 'Running OCR...' : 'Run OCR'}
                </button>
                <button
                  onClick={openOcrSettings}
                  className="px-4 py-2.5 rounded-full bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-slate-300 text-sm font-medium hover:bg-gray-200 dark:hover:bg-slate-600 transition-colors"
                >
                  OCR Settings
                </button>
              </>
            )}
            {visiblePages.length > 1 && (
              <button
                onClick={() => setReorderMode((m) => !m)}
                className={`px-4 py-2.5 rounded-full text-sm font-medium transition-colors ${
                  reorderMode
                    ? 'bg-cail-blue text-white hover:bg-cail-navy'
                    : 'bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-slate-300 hover:bg-gray-200 dark:hover:bg-slate-600'
                }`}
              >
                {reorderMode ? 'Done Reordering' : 'Reorder'}
              </button>
            )}
            {role !== 'viewer' && (
              <button
                onClick={() => setShowUploadZone((v) => !v)}
                className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                  showUploadZone
                    ? 'bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-slate-300 hover:bg-gray-200 dark:hover:bg-slate-600'
                    : 'bg-cail-blue/10 text-cail-blue hover:bg-cail-blue/20'
                }`}
              >
                {showUploadZone ? 'Cancel' : '+ Add Pages'}
              </button>
            )}
            <span className="text-sm text-gray-500 dark:text-slate-400">
              {visiblePages.length} page{visiblePages.length !== 1 ? 's' : ''}
            </span>
          </div>

          {/* Upload drop zone */}
          {showUploadZone && <div
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => { setUploadSuccess(''); handleDrop(e); }}
            onClick={() => { if (!uploading) { setUploadSuccess(''); fileInputRef.current?.click(); } }}
            className={`mb-6 border-2 border-dashed rounded-xl p-4 text-center cursor-pointer transition-all ${
              dragOver ? 'border-cail-blue bg-cail-blue/5' : uploadSuccess ? 'border-green-300 bg-green-50' : 'border-gray-200 dark:border-slate-700 hover:border-cail-blue/50'
            }`}
          >
            {uploading ? (
              <div className="flex items-center justify-center gap-3">
                <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-cail-blue"></div>
                <p className="text-sm text-gray-500 dark:text-slate-400">{uploadProgress}</p>
              </div>
            ) : uploadSuccess ? (
              <div className="flex items-center justify-center gap-2">
                <svg className="w-5 h-5 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
                <p className="text-sm text-green-700 font-medium">{uploadSuccess}</p>
                <span className="text-xs text-green-500 ml-1">— click or drop to add more</span>
              </div>
            ) : (
              <div className="flex items-center justify-center gap-2">
                <svg className="w-5 h-5 text-gray-400 dark:text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                </svg>
                <p className="text-sm text-gray-500 dark:text-slate-400">
                  Drop images or PDFs here, or click to browse
                </p>
              </div>
            )}
          </div>}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/*,.pdf,.heic,.heif"
            onChange={handleFileSelect}
            className="hidden"
          />

          {/* OCR Progress */}
          {ocrRunning && ocrProgress.total > 0 && (
            <div className="mb-6 bg-white dark:bg-slate-800 rounded-2xl border border-gray-100 dark:border-slate-700 p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-gray-600 dark:text-slate-400">OCR Progress</span>
                <span className="text-sm text-gray-500 dark:text-slate-400">
                  {ocrProgress.page}/{ocrProgress.total}
                </span>
              </div>
              <div className="w-full bg-gray-100 dark:bg-slate-700 rounded-full h-2">
                <div
                  className="h-2 rounded-full bg-cail-teal transition-all"
                  style={{ width: `${(ocrProgress.page / ocrProgress.total) * 100}%` }}
                />
              </div>
            </div>
          )}

          {/* Thumbnail grid */}
          {visiblePages.length === 0 ? (
            <div className="text-center py-12 bg-white dark:bg-slate-800 rounded-2xl border border-gray-100 dark:border-slate-700">
              <p className="text-sm text-gray-500 dark:text-slate-400">No pages uploaded yet. Use the drop zone above to add images.</p>
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
              {visiblePages.map((page, idx) => (
                <div
                  key={page.id || idx}
                  draggable={reorderMode}
                  onDragStart={reorderMode ? (e) => {
                    setDragIdx(idx);
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', String(idx));
                  } : undefined}
                  onDragOver={reorderMode ? (e) => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    setDragOverIdx(idx);
                  } : undefined}
                  onDragLeave={reorderMode ? () => setDragOverIdx(null) : undefined}
                  onDrop={reorderMode ? (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const from = parseInt(e.dataTransfer.getData('text/plain'), 10);
                    setDragIdx(null);
                    setDragOverIdx(null);
                    if (!isNaN(from)) handleReorderDrop(from, idx);
                  } : undefined}
                  onDragEnd={reorderMode ? () => { setDragIdx(null); setDragOverIdx(null); } : undefined}
                  className={`relative bg-white rounded-xl border overflow-hidden group transition-all ${
                    reorderMode ? 'cursor-grab active:cursor-grabbing ring-1 ring-cail-blue/20' : 'hover:shadow-md'
                  } ${
                    dragIdx === idx ? 'opacity-40 scale-95' : ''
                  } ${
                    dragOverIdx === idx && dragIdx !== idx ? 'border-cail-blue ring-2 ring-cail-blue/30' : 'border-gray-100'
                  }`}
                >
                  {/* Delete button (visible on hover, hidden in reorder mode and for viewers) */}
                  {!reorderMode && role !== 'viewer' && (
                    <button
                      onClick={(e) => { e.stopPropagation(); handleDeletePage(page.id); }}
                      className="absolute top-1 right-1 z-10 w-6 h-6 rounded-full bg-red-500 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-600"
                      title="Delete page"
                    >
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  )}
                  <div
                    className={`aspect-[3/4] bg-gray-50 dark:bg-slate-900 ${reorderMode ? '' : 'cursor-pointer'}`}
                    onClick={reorderMode ? undefined : () => setLightboxPage(idx)}
                  >
                    <img
                      src={`${BASE}/api/texts/${id}/image/${page.filename}?w=200`}
                      alt={`Page ${idx + 1}`}
                      className="w-full h-full object-cover pointer-events-none"
                      loading="lazy"
                    />
                  </div>
                  <div className="p-2 flex items-center justify-between">
                    <span className="text-xs text-gray-500 dark:text-slate-400">Page {idx + 1}</span>
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
          {reorderMode && (
            <p className="text-xs text-gray-400 mt-3 text-center">Drag pages to reorder, then click Done Reordering</p>
          )}
        </div>
      )}

      {/* ============================================================ */}
      {/* FULL TEXT TAB — Read-only rendered view (Task 7) */}
      {/* ============================================================ */}
      {activeTab === 'Full Text' && (
        <div role="tabpanel" id={`tabpanel-${activeTab.toLowerCase().replace(/\s+/g, '-')}`} aria-labelledby={`tab-${activeTab.toLowerCase().replace(/\s+/g, '-')}`} tabIndex={0}>
          <div className="flex items-center gap-3 mb-4">
            <button
              onClick={copyFullText}
              className={`px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${
                copySuccess
                  ? 'bg-green-100 text-green-700'
                  : 'bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-slate-300 hover:bg-gray-200 dark:hover:bg-slate-600'
              }`}
            >
              {copySuccess ? 'Copied!' : 'Copy to Clipboard'}
            </button>
            <span className="text-sm text-gray-400 dark:text-slate-500">
              Read-only view. Edit individual pages in the Review tab.
            </span>
          </div>

          {fullText ? (
            <div
              className="bg-white dark:bg-slate-800 rounded-2xl border border-gray-100 dark:border-slate-700 p-6 prose prose-sm dark:prose-invert max-w-none min-h-[400px]"
              dangerouslySetInnerHTML={{
                __html: renderSanitizedMarkdown(fullText)
              }}
            />
          ) : (
            <div className="text-center py-12 bg-white dark:bg-slate-800 rounded-2xl border border-gray-100 dark:border-slate-700">
              <p className="text-sm text-gray-500 dark:text-slate-400">No OCR text yet. Run OCR on the Pages tab first.</p>
            </div>
          )}
        </div>
      )}

      {/* ============================================================ */}
      {/* REVIEW TAB — with sidebar (Task 4) and toolbar (Task 5) */}
      {/* ============================================================ */}
      {activeTab === 'Review' && (
        <div role="tabpanel" id={`tabpanel-${activeTab.toLowerCase().replace(/\s+/g, '-')}`} aria-labelledby={`tab-${activeTab.toLowerCase().replace(/\s+/g, '-')}`} tabIndex={0}>
          {visiblePages.length === 0 ? (
            <div className="text-center py-12 bg-white dark:bg-slate-800 rounded-2xl border border-gray-100 dark:border-slate-700">
              <p className="text-sm text-gray-500 dark:text-slate-400">No pages to review.</p>
            </div>
          ) : (
            <>
              {/* Top bar */}
              <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setReviewPage((p) => Math.max(0, p - 1))}
                    disabled={reviewPage === 0}
                    className="p-2 rounded-lg border border-gray-200 dark:border-slate-700 hover:bg-gray-50 dark:hover:bg-slate-800 dark:bg-slate-900 disabled:opacity-30 transition-colors"
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
                    className="p-2 rounded-lg border border-gray-200 dark:border-slate-700 hover:bg-gray-50 dark:hover:bg-slate-800 dark:bg-slate-900 disabled:opacity-30 transition-colors"
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                  </button>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => setShowShortcuts(true)} className="w-7 h-7 rounded-full text-xs font-bold text-gray-400 hover:text-gray-600 dark:hover:text-slate-300 hover:bg-gray-100 dark:hover:bg-slate-700 transition-colors" title="Keyboard shortcuts (?)">
                    ?
                  </button>
                  <button onClick={() => setShowVersions(true)} className="px-3 py-1.5 rounded-full text-xs font-medium text-gray-600 hover:bg-gray-100 dark:hover:bg-slate-700 transition-colors">
                    History
                  </button>
                  <button onClick={() => setShowAnnotations(true)} className="px-3 py-1.5 rounded-full text-xs font-medium text-gray-600 hover:bg-gray-100 dark:hover:bg-slate-700 transition-colors">
                    Comments
                  </button>
                  <button
                    onClick={savePageReview}
                    disabled={savingPage || role === 'viewer'}
                    className="px-4 py-1.5 rounded-full bg-cail-blue text-white text-sm font-medium hover:bg-cail-navy transition-colors disabled:opacity-50"
                  >
                    {savingPage ? 'Saving...' : 'Save Page'}
                  </button>
                </div>
              </div>

              {/* 3-column layout: sidebar | image | editor */}
              <div className="flex flex-col md:flex-row gap-4" style={{ minHeight: '50vh' }}>
                {/* Page sidebar */}
                <div className="w-40 flex-shrink-0 bg-white dark:bg-slate-800 rounded-2xl border border-gray-100 dark:border-slate-700 overflow-y-auto hidden md:block">
                  {visiblePages.map((page, idx) => (
                    <button
                      key={page.id || idx}
                      onClick={() => setReviewPage(idx)}
                      className={`w-full text-left px-3 py-2 text-sm transition-colors border-l-2 ${
                        idx === reviewPage
                          ? 'bg-cail-blue/10 border-cail-blue text-cail-blue font-medium'
                          : 'border-transparent text-gray-600 hover:bg-gray-50 dark:hover:bg-slate-800'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span>Page {idx + 1}</span>
                        {page.ocr_text ? (
                          <svg className="w-3 h-3 text-green-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                          </svg>
                        ) : (
                          <span className="w-1.5 h-1.5 rounded-full bg-gray-300 flex-shrink-0"></span>
                        )}
                      </div>
                    </button>
                  ))}
                </div>

                {/* Image */}
                <div className="flex-1 bg-white dark:bg-slate-800 rounded-2xl border border-gray-100 dark:border-slate-700 overflow-hidden flex flex-col min-w-0 max-h-[40vh] md:max-h-none md:h-[65vh]">
                  <div className="flex items-center justify-end gap-2 px-3 py-1.5 border-b border-gray-100 dark:border-slate-700">
                    <button
                      onClick={() => { setReviewZoom((z) => { const n = Math.max(1, z - 0.25); if (n <= 1) setReviewPan({ x: 0, y: 0 }); return n; }); }}
                      disabled={reviewZoom <= 1}
                      className="w-7 h-7 flex items-center justify-center rounded-full text-sm font-bold text-gray-500 hover:bg-gray-100 dark:hover:bg-slate-700 disabled:opacity-30"
                      title="Zoom out"
                    >-</button>
                    <button
                      onClick={() => { setReviewZoom(1); setReviewPan({ x: 0, y: 0 }); }}
                      className="px-2 py-0.5 rounded text-xs font-medium text-gray-500 hover:bg-gray-100 dark:hover:bg-slate-700 tabular-nums"
                      title="Reset zoom"
                    >{Math.round(reviewZoom * 100)}%</button>
                    <button
                      onClick={() => setReviewZoom((z) => Math.min(5, z + 0.25))}
                      className="w-7 h-7 flex items-center justify-center rounded-full text-sm font-bold text-gray-500 hover:bg-gray-100 dark:hover:bg-slate-700"
                      title="Zoom in"
                    >+</button>
                  </div>
                  <div
                    className="flex-1 overflow-hidden flex items-center justify-center"
                    style={{ cursor: reviewZoom > 1 ? (reviewDragging ? 'grabbing' : 'grab') : 'default' }}
                    onWheel={(e) => {
                      e.stopPropagation();
                      const delta = e.deltaY > 0 ? 0.25 : -0.25;
                      setReviewZoom((z) => {
                        const next = Math.min(5, Math.max(1, z + delta));
                        if (next <= 1) setReviewPan({ x: 0, y: 0 });
                        return next;
                      });
                    }}
                    onMouseDown={(e) => {
                      if (reviewZoom <= 1) return;
                      e.preventDefault();
                      setReviewDragging(true);
                      reviewDragStart.current = { x: e.clientX, y: e.clientY, panX: reviewPan.x, panY: reviewPan.y };
                    }}
                    onMouseMove={(e) => {
                      if (!reviewDragging) return;
                      setReviewPan({
                        x: reviewDragStart.current.panX + (e.clientX - reviewDragStart.current.x),
                        y: reviewDragStart.current.panY + (e.clientY - reviewDragStart.current.y),
                      });
                    }}
                    onMouseUp={() => setReviewDragging(false)}
                    onMouseLeave={() => setReviewDragging(false)}
                  >
                    {visiblePages[reviewPage] && (
                      <img
                        src={`${BASE}/api/texts/${id}/image/${visiblePages[reviewPage].filename}`}
                        alt={`Page ${reviewPage + 1}`}
                        className="max-w-full max-h-full object-contain pointer-events-none select-none"
                        style={{
                          transform: `scale(${reviewZoom}) translate(${reviewPan.x / reviewZoom}px, ${reviewPan.y / reviewZoom}px)`,
                          transformOrigin: 'center center',
                        }}
                        draggable={false}
                      />
                    )}
                  </div>
                </div>

                {/* Text editor with toolbar */}
                <div className="flex-1 flex flex-col min-w-0 md:h-[65vh]">
                  {draftBanner && (
                    <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 mb-3 flex items-center justify-between">
                      <span className="text-sm text-amber-800">
                        Unsaved draft found from {new Date(draftBanner.savedAt).toLocaleString()}.
                      </span>
                      <div className="flex gap-2">
                        <button
                          onClick={() => { const content = restoreDraft(); if (content) setPageText(content); }}
                          className="text-sm font-medium text-amber-700 hover:text-amber-900"
                        >
                          Restore
                        </button>
                        <button onClick={dismissDraft} className="text-sm text-gray-500 hover:text-gray-700 dark:text-slate-300">
                          Dismiss
                        </button>
                      </div>
                    </div>
                  )}
                  {/* Markdown toolbar */}
                  <div className="flex items-center gap-1 bg-white dark:bg-slate-800 rounded-t-2xl border border-gray-100 dark:border-slate-700 border-b-0 p-1.5">
                    <button onClick={() => insertReviewMarkdown('**', '**')} className="px-3 py-1 rounded text-sm font-bold text-gray-600 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-700 transition-colors" title="Bold">B</button>
                    <button onClick={() => insertReviewMarkdown('*', '*')} className="px-3 py-1 rounded text-sm italic text-gray-600 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-700 transition-colors" title="Italic">I</button>
                    <button onClick={() => insertReviewMarkdown('# ')} className="px-2 py-1 rounded text-xs font-bold text-gray-600 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-700 transition-colors" title="Heading 1">H1</button>
                    <button onClick={() => insertReviewMarkdown('## ')} className="px-2 py-1 rounded text-xs font-bold text-gray-600 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-700 transition-colors" title="Heading 2">H2</button>
                    <button onClick={() => insertReviewMarkdown('### ')} className="px-2 py-1 rounded text-xs font-bold text-gray-600 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-700 transition-colors" title="Heading 3">H3</button>
                    <button onClick={() => insertReviewMarkdown('\n\n---\n\n')} className="px-3 py-1 rounded text-sm text-gray-600 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-700 transition-colors" title="Separator">--</button>
                    <button onClick={() => insertReviewMarkdown('> ')} className="px-3 py-1 rounded text-sm text-gray-600 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-700 transition-colors" title="Blockquote">&ldquo;</button>
                  </div>
                  <textarea
                    ref={reviewTextareaRef}
                    value={pageText}
                    onChange={(e) => setPageText(e.target.value)}
                    readOnly={role === 'viewer'}
                    aria-label="Markdown editor"
                    className={`w-full flex-1 px-4 py-3 rounded-b-2xl border border-gray-200 dark:border-slate-700 focus:border-cail-blue focus:ring-2 focus:ring-cail-blue/20 outline-none transition text-sm font-mono resize-none ${role === 'viewer' ? 'bg-gray-50 dark:bg-slate-900 cursor-not-allowed' : 'bg-white dark:bg-slate-800'} dark:text-slate-200`}
                    placeholder="OCR text for this page..."
                  />
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* ============================================================ */}
      {/* TRANSLATION TAB (Task 6) */}
      {/* ============================================================ */}
      {activeTab === 'Translation' && (
        <div role="tabpanel" id={`tabpanel-${activeTab.toLowerCase().replace(/\s+/g, '-')}`} aria-labelledby={`tab-${activeTab.toLowerCase().replace(/\s+/g, '-')}`} tabIndex={0}>
          <div className="flex items-center gap-3 mb-4 flex-wrap">
            <div className="flex items-center gap-2">
              <label className="text-sm font-medium text-gray-700 dark:text-slate-300">Target Language</label>
              <select
                value={targetLang}
                onChange={(e) => setTargetLang(e.target.value)}
                className="text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-slate-700 focus:border-cail-blue outline-none"
              >
                {LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code}>{l.label}</option>
                ))}
              </select>
            </div>
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
            <button
              onClick={() => setTranslationSideBySide(!translationSideBySide)}
              className={`px-4 py-2 rounded-full text-sm font-medium transition-colors ml-auto ${
                translationSideBySide ? 'bg-cail-blue text-white' : 'bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-slate-300 hover:bg-gray-200 dark:hover:bg-slate-600'
              }`}
            >
              {translationSideBySide ? 'Single View' : 'Side by Side'}
            </button>
          </div>

          {translationSideBySide ? (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4" style={{ minHeight: '400px' }}>
              {/* Original text (read-only) */}
              <div>
                <h3 className="text-sm font-medium text-gray-500 mb-2">Original Text</h3>
                <div
                  className="bg-white dark:bg-slate-800 rounded-2xl border border-gray-100 dark:border-slate-700 p-4 prose prose-sm dark:prose-invert max-w-none h-[500px] overflow-y-auto"
                  dangerouslySetInnerHTML={{
                    __html: renderSanitizedMarkdown(fullText)
                  }}
                />
              </div>
              {/* Translation (editable) */}
              <div>
                <h3 className="text-sm font-medium text-gray-500 mb-2">Translation</h3>
                <textarea
                  value={translation}
                  onChange={(e) => setTranslation(e.target.value)}
                  className="w-full h-[500px] px-4 py-3 rounded-2xl border border-gray-200 dark:border-slate-700 focus:border-cail-blue focus:ring-2 focus:ring-cail-blue/20 outline-none transition text-sm font-mono resize-none bg-white dark:bg-slate-800"
                  placeholder="Translation will appear here..."
                />
              </div>
            </div>
          ) : (
            <textarea
              value={translation}
              onChange={(e) => setTranslation(e.target.value)}
              className="w-full min-h-[500px] px-4 py-3 rounded-2xl border border-gray-200 dark:border-slate-700 focus:border-cail-blue focus:ring-2 focus:ring-cail-blue/20 outline-none transition text-sm font-mono resize-y bg-white dark:bg-slate-800"
              placeholder="Translation will appear here..."
            />
          )}
        </div>
      )}

      {/* ============================================================ */}
      {/* DETAILS TAB — Summary + Metadata only */}
      {/* ============================================================ */}
      {activeTab === 'Details' && (
        <div role="tabpanel" id={`tabpanel-${activeTab.toLowerCase().replace(/\s+/g, '-')}`} aria-labelledby={`tab-${activeTab.toLowerCase().replace(/\s+/g, '-')}`} tabIndex={0} className="space-y-8">
          {/* Summary section */}
          <div className="bg-white dark:bg-slate-800 rounded-2xl border border-gray-100 dark:border-slate-700 p-6">
            <h3 className="font-display font-semibold text-lg text-cail-dark mb-4">Summary</h3>
            <textarea
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              rows={4}
              className="w-full px-4 py-3 rounded-xl border border-gray-200 dark:border-slate-700 focus:border-cail-blue focus:ring-2 focus:ring-cail-blue/20 outline-none transition text-sm resize-y"
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

          {/* Dublin Core Metadata */}
          <div className="bg-white dark:bg-slate-800 rounded-2xl border border-gray-100 dark:border-slate-700 p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-display font-semibold text-lg text-cail-dark dark:text-slate-200">Dublin Core Metadata</h3>
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
                    className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-slate-700 focus:border-cail-blue outline-none text-sm"
                  />
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ============================================================ */}
      {/* LIGHTBOX (Task 2) */}
      {/* ============================================================ */}
      {lightboxPage !== null && (
        <div
          className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center"
          onClick={() => { setLightboxPage(null); lbResetView(); }}
          onMouseMove={lbMouseMove}
          onMouseUp={lbMouseUp}
          onMouseLeave={lbMouseUp}
        >
          {/* Top bar */}
          <div className="absolute top-0 left-0 right-0 z-20 flex items-center justify-between px-4 py-3 bg-gradient-to-b from-black/60 to-transparent" onClick={(e) => e.stopPropagation()}>
            <div className="text-white text-sm font-medium">
              Page {lightboxPage + 1} of {visiblePages.length}
            </div>
            <div className="flex items-center gap-1">
              {/* Zoom out */}
              <button
                onClick={() => setLbZoom((z) => { const n = Math.max(0.5, z - 0.25); if (n <= 1) setLbPan({ x: 0, y: 0 }); return n; })}
                className="p-2 rounded-lg text-white/70 hover:text-white hover:bg-white/10 transition-colors"
                title="Zoom out (−)"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0zM13 10H7" />
                </svg>
              </button>
              {/* Zoom indicator / reset */}
              <button
                onClick={lbResetView}
                className="px-2 py-1 rounded-lg text-white/80 hover:text-white hover:bg-white/10 text-xs font-mono min-w-[3.5rem] text-center transition-colors"
                title="Reset zoom (0)"
              >
                {Math.round(lbZoom * 100)}%
              </button>
              {/* Zoom in */}
              <button
                onClick={() => setLbZoom((z) => Math.min(5, z + 0.25))}
                className="p-2 rounded-lg text-white/70 hover:text-white hover:bg-white/10 transition-colors"
                title="Zoom in (+)"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0zM10 7v6m3-3H7" />
                </svg>
              </button>
              {/* Fit to screen */}
              <button
                onClick={() => { setLbZoom(1); setLbPan({ x: 0, y: 0 }); }}
                className="p-2 rounded-lg text-white/70 hover:text-white hover:bg-white/10 transition-colors ml-1"
                title="Fit to screen"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
                </svg>
              </button>
              {/* Close */}
              <button
                onClick={() => { setLightboxPage(null); lbResetView(); }}
                className="p-2 rounded-lg text-white/70 hover:text-white hover:bg-white/10 transition-colors ml-2"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>

          {/* Prev button */}
          {lightboxPage > 0 && (
            <button
              onClick={(e) => { e.stopPropagation(); lbGoTo(lightboxPage - 1); }}
              className="absolute left-4 top-1/2 -translate-y-1/2 z-10 p-2 rounded-full bg-white/20 text-white hover:bg-white/30 transition-colors"
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
          )}

          {/* Image container */}
          <div
            className="overflow-hidden w-full h-full flex items-center justify-center"
            onWheel={lbHandleWheel}
            onClick={(e) => e.stopPropagation()}
            style={{ cursor: lbZoom > 1 ? (lbDragging ? 'grabbing' : 'grab') : 'default' }}
          >
            <img
              src={`${BASE}/api/texts/${id}/image/${visiblePages[lightboxPage]?.filename}`}
              alt={`Page ${lightboxPage + 1}`}
              className="max-w-[90vw] max-h-[90vh] object-contain select-none"
              style={{
                transform: `scale(${lbZoom}) translate(${lbPan.x / lbZoom}px, ${lbPan.y / lbZoom}px)`,
                transition: lbDragging ? 'none' : 'transform 0.15s ease-out',
              }}
              draggable={false}
              onMouseDown={lbMouseDown}
            />
          </div>

          {/* Next button */}
          {lightboxPage < visiblePages.length - 1 && (
            <button
              onClick={(e) => { e.stopPropagation(); lbGoTo(lightboxPage + 1); }}
              className="absolute right-4 top-1/2 -translate-y-1/2 z-10 p-2 rounded-full bg-white/20 text-white hover:bg-white/30 transition-colors"
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </button>
          )}

          {/* Bottom hint */}
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-20 px-4 py-2 rounded-full bg-black/50 text-white/60 text-xs" onClick={(e) => e.stopPropagation()}>
            Scroll to zoom · Drag to pan · Arrow keys to navigate · Esc to close
          </div>
        </div>
      )}

      {/* ============================================================ */}
      {/* OCR SETTINGS MODAL (Task 11) */}
      {/* ============================================================ */}
      {showOcrSettings && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
          <div className="bg-white rounded-2xl shadow-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto p-6">
            <div className="flex items-center justify-between mb-6">
              <h2 className="font-display font-semibold text-xl text-cail-dark dark:text-slate-200">OCR Settings</h2>
              <button onClick={() => setShowOcrSettings(false)} className="text-gray-400 hover:text-gray-600 dark:hover:text-slate-300 dark:text-slate-400">
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Preset</label>
                <select
                  value={OCR_PRESETS.find((p) => p.prompt && p.prompt === ocrSettings.prompt)?.key || ''}
                  onChange={(e) => {
                    const preset = OCR_PRESETS.find((p) => p.key === e.target.value);
                    if (preset?.prompt) {
                      setOcrSettings((s) => ({ ...s, prompt: preset.prompt }));
                    }
                  }}
                  className="w-full text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-slate-700 focus:border-cail-blue outline-none"
                >
                  {OCR_PRESETS.map((p) => (
                    <option key={p.key} value={p.key}>{p.label}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">OCR Prompt</label>
                <textarea
                  value={ocrSettings.prompt}
                  onChange={(e) => setOcrSettings((s) => ({ ...s, prompt: e.target.value }))}
                  rows={8}
                  className="w-full px-4 py-3 rounded-xl border border-gray-200 dark:border-slate-700 focus:border-cail-blue focus:ring-2 focus:ring-cail-blue/20 outline-none transition text-sm font-mono resize-y"
                  placeholder="Leave empty to use default prompt..."
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Model ID</label>
                <input
                  type="text"
                  value={ocrSettings.model}
                  onChange={(e) => setOcrSettings((s) => ({ ...s, model: e.target.value }))}
                  className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-slate-700 focus:border-cail-blue outline-none text-sm"
                  placeholder="Leave empty to use default model"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Temperature: {ocrSettings.temperature}
                  </label>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.05"
                    value={ocrSettings.temperature}
                    onChange={(e) => setOcrSettings((s) => ({ ...s, temperature: parseFloat(e.target.value) }))}
                    className="w-full"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Max Tokens</label>
                  <input
                    type="number"
                    value={ocrSettings.max_tokens}
                    onChange={(e) => setOcrSettings((s) => ({ ...s, max_tokens: parseInt(e.target.value, 10) || 8192 }))}
                    className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-slate-700 focus:border-cail-blue outline-none text-sm"
                    min={256}
                    max={32768}
                  />
                </div>
              </div>
            </div>

            <div className="flex items-center justify-between mt-6">
              <button
                onClick={resetOcrSettings}
                className="px-4 py-2 rounded-full text-sm font-medium text-gray-600 hover:bg-gray-100 dark:hover:bg-slate-700 transition-colors"
              >
                Reset to Default
              </button>
              <div className="flex gap-3">
                <button
                  onClick={() => setShowOcrSettings(false)}
                  className="px-4 py-2 rounded-full text-sm font-medium text-gray-600 hover:bg-gray-100 dark:hover:bg-slate-700 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={saveOcrSettings}
                  disabled={savingSettings}
                  className="px-6 py-2 rounded-full bg-cail-blue text-white text-sm font-medium hover:bg-cail-navy transition-colors disabled:opacity-50"
                >
                  {savingSettings ? 'Saving...' : 'Save Settings'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <VersionHistory textId={text?.id} contentType="compiled" open={showVersions} onClose={() => setShowVersions(false)} onRevert={() => loadText()} />
      <AnnotationSidebar textId={text?.id} open={showAnnotations} onClose={() => setShowAnnotations(false)} role={role} />
      {showShortcuts && <KeyboardShortcuts onClose={() => setShowShortcuts(false)} />}
    </div>
  );
}
