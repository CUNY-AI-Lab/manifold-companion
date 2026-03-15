import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { ManifoldLogo } from '../components/Header';
import { BASE } from '../api/client';

/* ------------------------------------------------------------------ */
/*  Noise texture (same one Footer uses — keeps visual consistency)   */
/* ------------------------------------------------------------------ */
const NOISE_SVG = "data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E";

/* ------------------------------------------------------------------ */
/*  Intersection-observer hook for scroll reveals                     */
/* ------------------------------------------------------------------ */
function useReveal() {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) { el.classList.add('revealed'); observer.unobserve(el); } },
      { threshold: 0.15 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return ref;
}

function RevealSection({ children, className = '', delay = 0 }) {
  const ref = useReveal();
  return (
    <div
      ref={ref}
      className={`reveal-on-scroll ${className}`}
      style={{ transitionDelay: `${delay}ms` }}
    >
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Step cards for workflow instructions                               */
/* ------------------------------------------------------------------ */
function StepCard({ number, title, children, accent = 'cail-blue' }) {
  const colors = {
    'cail-blue': { bg: 'bg-cail-blue/5', border: 'border-cail-blue/20', num: 'text-cail-blue', dot: 'bg-cail-blue' },
    'cail-teal': { bg: 'bg-cail-teal/5', border: 'border-cail-teal/20', num: 'text-cail-teal', dot: 'bg-cail-teal' },
  };
  const c = colors[accent];
  return (
    <div className={`relative pl-10 py-4 border-l-2 ${c.border}`}>
      <div className={`absolute left-[-9px] top-5 w-4 h-4 rounded-full ${c.dot} ring-4 ring-white`} />
      <span className={`font-display text-xs font-semibold uppercase tracking-widest ${c.num}`}>Step {number}</span>
      <h4 className="font-display font-semibold text-cail-dark mt-1 text-[15px]">{title}</h4>
      <p className="text-sm text-gray-500 mt-1.5 leading-relaxed">{children}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Feature pill                                                      */
/* ------------------------------------------------------------------ */
function FeaturePill({ icon, children }) {
  return (
    <div className="flex items-start gap-3 p-4 rounded-2xl bg-white border border-gray-100 shadow-sm hover:shadow-md hover:-translate-y-0.5 transition-all duration-300">
      <span className="text-lg shrink-0 mt-0.5">{icon}</span>
      <p className="text-sm text-gray-600 leading-relaxed">{children}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main About page                                                   */
/* ------------------------------------------------------------------ */
export default function AboutPage() {
  return (
    <div className="min-h-screen">
      <style>{`
        .reveal-on-scroll {
          opacity: 0;
          transform: translateY(24px);
          transition: opacity 0.7s cubic-bezier(0.16, 1, 0.3, 1),
                      transform 0.7s cubic-bezier(0.16, 1, 0.3, 1);
        }
        .reveal-on-scroll.revealed {
          opacity: 1;
          transform: translateY(0);
        }
        @keyframes float-slow {
          0%, 100% { transform: translateY(0) rotate(0deg); }
          50% { transform: translateY(-12px) rotate(1deg); }
        }
        .float-slow { animation: float-slow 8s ease-in-out infinite; }
        @keyframes grain { 0%,100%{transform:translate(0)} 10%{transform:translate(-5%,-10%)} 20%{transform:translate(-15%,5%)} 30%{transform:translate(7%,-25%)} 40%{transform:translate(-5%,25%)} 50%{transform:translate(-15%,10%)} 60%{transform:translate(15%)} 70%{transform:translate(0,15%)} 80%{transform:translate(3%,35%)} 90%{transform:translate(-10%,10%)} }
      `}</style>

      {/* ============================================================ */}
      {/*  HERO                                                        */}
      {/* ============================================================ */}
      <section className="relative overflow-hidden bg-gradient-to-br from-cail-navy via-[#1a3370] to-[#142a5c] text-white">
        {/* Grain overlay */}
        <div
          className="absolute inset-0 opacity-[0.04] pointer-events-none"
          style={{ backgroundImage: `url("${NOISE_SVG}")`, animation: 'grain 3s steps(6) infinite' }}
        />

        {/* Large watermark logo */}
        <div className="absolute -right-20 -bottom-16 opacity-[0.06] float-slow pointer-events-none">
          <ManifoldLogo className="w-[420px] h-[420px]" />
        </div>

        {/* Diagonal slice at the bottom */}
        <div className="absolute bottom-0 left-0 right-0 h-20 bg-cail-cream"
          style={{ clipPath: 'polygon(0 100%, 100% 100%, 100% 0)' }} />

        <div className="relative max-w-5xl mx-auto px-6 sm:px-8 pt-20 pb-32 sm:pt-28 sm:pb-40">
          <RevealSection>
            <div className="flex items-center gap-3 mb-8">
              <img
                src={`${BASE}/images/cail-logo-horizontal.png`}
                alt="CUNY AI Lab"
                className="h-7 w-auto brightness-0 invert opacity-80"
              />
            </div>
          </RevealSection>

          <RevealSection delay={100}>
            <h1 className="font-display font-bold text-4xl sm:text-5xl lg:text-6xl leading-[1.1] tracking-tight max-w-2xl">
              Manifold
              <br />
              <span className="text-cail-teal">Companion</span>
            </h1>
          </RevealSection>

          <RevealSection delay={200}>
            <p className="mt-6 text-lg sm:text-xl text-blue-100/80 max-w-xl leading-relaxed font-light">
              A document-processing platform that transforms scanned pages, historical manuscripts,
              and digital PDFs into publication-ready texts for{' '}
              <a
                href="https://cuny.manifoldapp.org/"
                target="_blank"
                rel="noopener noreferrer"
                className="text-cail-teal hover:text-white underline underline-offset-4 decoration-cail-teal/40 hover:decoration-white/60 transition-colors"
              >
                CUNY Manifold
              </a>.
            </p>
          </RevealSection>

          <RevealSection delay={300}>
            <div className="mt-10 flex flex-wrap gap-4">
              <Link
                to="/"
                className="inline-flex items-center gap-2 px-6 py-3 rounded-full bg-white text-cail-navy font-display font-semibold text-sm hover:bg-cail-teal hover:text-white transition-all duration-300 shadow-lg shadow-black/10"
              >
                Go to Dashboard
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8l4 4m0 0l-4 4m4-4H3" />
                </svg>
              </Link>
            </div>
          </RevealSection>
        </div>
      </section>

      {/* ============================================================ */}
      {/*  WHAT IT DOES                                                */}
      {/* ============================================================ */}
      <section className="relative bg-cail-cream">
        <div className="max-w-5xl mx-auto px-6 sm:px-8 py-20 sm:py-28">
          <RevealSection>
            <p className="font-display text-xs font-semibold uppercase tracking-[0.2em] text-cail-blue mb-4">Overview</p>
            <h2 className="font-display font-bold text-2xl sm:text-3xl text-cail-dark max-w-2xl leading-tight">
              Built for researchers, students, and instructors who work with printed and handwritten texts
            </h2>
            <p className="mt-5 text-gray-500 max-w-2xl leading-relaxed">
              The Manifold Companion digitizes documents using AI vision models, then lets you review,
              correct, annotate, and collaborate before exporting publication-ready files for
              CUNY&apos;s Manifold scholarly publishing platform.
            </p>
          </RevealSection>

          <RevealSection delay={80}>
            <div className="mt-8 flex items-start gap-3 bg-white rounded-2xl border border-cail-blue/10 p-5">
              <span className="text-cail-blue mt-0.5 shrink-0">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
                </svg>
              </span>
              <div className="text-sm text-gray-500 leading-relaxed">
                <strong className="text-cail-dark">Transparency &amp; privacy.</strong>{' '}
                The Image-to-Markdown pipeline (OCR, summaries, translations) uses{' '}
                <strong className="text-gray-600">AWS Bedrock</strong>. The PDF-to-HTML pipeline uses{' '}
                <strong className="text-gray-600">Google Gemini via OpenRouter</strong>.
                Both providers operate under <strong className="text-gray-600">zero data retention</strong> policies
                — your documents are processed and immediately discarded, never used for model training.
              </div>
            </div>
          </RevealSection>

          <RevealSection delay={150}>
            <div className="mt-14 grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
              <FeaturePill icon="&#9998;">
                <strong className="text-cail-dark">AI-powered OCR</strong> — extract text from scans, photographs, and handwritten pages using state-of-the-art vision models
              </FeaturePill>
              <FeaturePill icon="&#128221;">
                <strong className="text-cail-dark">Rich editing</strong> — review page by page in Markdown or edit structured HTML with headings, tables, math, and figures
              </FeaturePill>
              <FeaturePill icon="&#128101;">
                <strong className="text-cail-dark">Collaboration</strong> — share projects with editors and viewers, leave threaded comments with @mentions, get notified of changes
              </FeaturePill>
              <FeaturePill icon="&#128202;">
                <strong className="text-cail-dark">Summaries &amp; translations</strong> — generate AI summaries and translate text into 40+ languages with a single click
              </FeaturePill>
              <FeaturePill icon="&#128218;">
                <strong className="text-cail-dark">Dublin Core metadata</strong> — fill in scholarly cataloging fields so your export is ready for library-grade archiving
              </FeaturePill>
              <FeaturePill icon="&#128230;">
                <strong className="text-cail-dark">Manifold export</strong> — download a ZIP archive with structured HTML and images, ready to import into Manifold as a new text
              </FeaturePill>
            </div>
          </RevealSection>
        </div>
      </section>

      {/* ============================================================ */}
      {/*  WORKFLOWS                                                   */}
      {/* ============================================================ */}
      <section className="relative bg-white">
        {/* Subtle top border accent */}
        <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-cail-blue/20 to-transparent" />

        <div className="max-w-5xl mx-auto px-6 sm:px-8 py-20 sm:py-28">
          <RevealSection>
            <p className="font-display text-xs font-semibold uppercase tracking-[0.2em] text-cail-teal mb-4">Workflows</p>
            <h2 className="font-display font-bold text-2xl sm:text-3xl text-cail-dark max-w-2xl leading-tight">
              Two paths to a published text
            </h2>
            <p className="mt-4 text-gray-500 max-w-xl">
              Choose the workflow that matches your source material. Both produce export-ready files.
            </p>
          </RevealSection>

          <div className="mt-16 grid lg:grid-cols-2 gap-12 lg:gap-16">
            {/* Workflow 1: Image to Markdown */}
            <RevealSection delay={100}>
              <div className="relative">
                <div className="flex items-center gap-3 mb-6">
                  <span className="flex items-center justify-center w-10 h-10 rounded-xl bg-cail-blue/10 text-cail-blue">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                    </svg>
                  </span>
                  <div>
                    <h3 className="font-display font-bold text-lg text-cail-dark">Image to Markdown</h3>
                    <p className="text-xs text-gray-400 mt-0.5">Scanned pages &middot; Photographs &middot; Handwritten texts</p>
                  </div>
                </div>

                <p className="text-sm text-gray-500 leading-relaxed mb-6">
                  Upload images or multi-page PDFs (rasterized to images). The AI extracts text
                  from each page into Markdown that you review and correct side-by-side with the
                  original scan.
                </p>

                <div className="space-y-0">
                  <StepCard number="1" title="Create a project" accent="cail-blue">
                    Choose &ldquo;Image to Markdown&rdquo; when creating a new project. Give it a name and set the document language.
                  </StepCard>
                  <StepCard number="2" title="Add a text and upload pages" accent="cail-blue">
                    Create a text (document) inside the project, then upload page images (JPEG, PNG, TIFF, BMP, WebP, HEIC) or drag in a PDF — it will be split into page images automatically.
                  </StepCard>
                  <StepCard number="3" title="Run OCR" accent="cail-blue">
                    Click &ldquo;Run OCR&rdquo; and the AI processes each page. Watch progress in real time via the streaming indicator.
                  </StepCard>
                  <StepCard number="4" title="Review and edit" accent="cail-blue">
                    Switch to the Review tab to see the extracted Markdown alongside page images. Edit page by page or use the compiled full-text view. Split or merge texts if pages are out of order.
                  </StepCard>
                  <StepCard number="5" title="Export" accent="cail-blue">
                    Fill in Dublin Core metadata, build your table of contents, and export as a ZIP ready to import into Manifold.
                  </StepCard>
                </div>
              </div>
            </RevealSection>

            {/* Workflow 2: PDF to HTML */}
            <RevealSection delay={250}>
              <div className="relative">
                <div className="flex items-center gap-3 mb-6">
                  <span className="flex items-center justify-center w-10 h-10 rounded-xl bg-cail-teal/10 text-cail-teal">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                  </span>
                  <div>
                    <h3 className="font-display font-bold text-lg text-cail-dark">PDF to HTML</h3>
                    <p className="text-xs text-gray-400 mt-0.5">Textbooks &middot; Articles &middot; Reports</p>
                  </div>
                </div>

                <p className="text-sm text-gray-500 leading-relaxed mb-6">
                  Upload a digital PDF and the AI converts it to structured HTML — preserving headings,
                  tables, lists, and math formulas (TeX notation rendered with KaTeX).
                </p>

                <div className="space-y-0">
                  <StepCard number="1" title="Create a project" accent="cail-teal">
                    Choose &ldquo;PDF to HTML&rdquo; when creating a new project.
                  </StepCard>
                  <StepCard number="2" title="Add a text and upload your PDF" accent="cail-teal">
                    Create a text inside the project, then upload the source PDF. The platform renders pages in-browser.
                  </StepCard>
                  <StepCard number="3" title="Convert" accent="cail-teal">
                    Click &ldquo;Convert to HTML&rdquo;. Each page is sent through the AI pipeline which returns semantic HTML. A cleanup pass normalizes headings and merges paragraph fragments.
                  </StepCard>
                  <StepCard number="4" title="Edit in the rich-text editor" accent="cail-teal">
                    The generated HTML appears in a WYSIWYG editor. Fix any conversion artifacts, adjust formatting, and verify math rendering. The original PDF is shown side by side for reference.
                  </StepCard>
                  <StepCard number="5" title="Export" accent="cail-teal">
                    Add metadata and export. HTML files include proper structure and MathML for Manifold compatibility. Download standalone HTML for other uses.
                  </StepCard>
                </div>
              </div>
            </RevealSection>
          </div>
        </div>
      </section>

      {/* ============================================================ */}
      {/*  COLLABORATION                                               */}
      {/* ============================================================ */}
      <section className="relative bg-cail-cream">
        <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-cail-teal/20 to-transparent" />

        <div className="max-w-5xl mx-auto px-6 sm:px-8 py-20 sm:py-28">
          <RevealSection>
            <p className="font-display text-xs font-semibold uppercase tracking-[0.2em] text-cail-blue mb-4">Collaboration</p>
            <h2 className="font-display font-bold text-2xl sm:text-3xl text-cail-dark max-w-2xl leading-tight">
              Work together on documents
            </h2>
          </RevealSection>

          <RevealSection delay={100}>
            <div className="mt-10 grid sm:grid-cols-2 gap-6">
              <div className="bg-white rounded-2xl border border-gray-100 p-6 shadow-sm">
                <h4 className="font-display font-semibold text-cail-dark text-[15px] mb-3">Sharing &amp; roles</h4>
                <ul className="space-y-2.5 text-sm text-gray-500">
                  <li className="flex items-start gap-2">
                    <span className="text-cail-blue mt-0.5 shrink-0">&#8227;</span>
                    Share any project with collaborators by email
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="text-cail-blue mt-0.5 shrink-0">&#8227;</span>
                    <strong className="text-gray-600">Viewers</strong> can read and export but not edit
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="text-cail-blue mt-0.5 shrink-0">&#8227;</span>
                    <strong className="text-gray-600">Editors</strong> can modify text, run OCR, and manage pages
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="text-cail-blue mt-0.5 shrink-0">&#8227;</span>
                    Project owners control who has access and at what level
                  </li>
                </ul>
              </div>

              <div className="bg-white rounded-2xl border border-gray-100 p-6 shadow-sm">
                <h4 className="font-display font-semibold text-cail-dark text-[15px] mb-3">Annotations &amp; notifications</h4>
                <ul className="space-y-2.5 text-sm text-gray-500">
                  <li className="flex items-start gap-2">
                    <span className="text-cail-teal mt-0.5 shrink-0">&#8227;</span>
                    Leave comments on any document via the annotations sidebar
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="text-cail-teal mt-0.5 shrink-0">&#8227;</span>
                    Reply to comments in threads, @mention collaborators
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="text-cail-teal mt-0.5 shrink-0">&#8227;</span>
                    Resolve and reopen discussions as work progresses
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="text-cail-teal mt-0.5 shrink-0">&#8227;</span>
                    In-app bell notifications and optional email alerts for replies, mentions, and shares
                  </li>
                </ul>
              </div>
            </div>
          </RevealSection>

          <RevealSection delay={200}>
            <div className="mt-6 grid sm:grid-cols-2 gap-6">
              <div className="bg-white rounded-2xl border border-gray-100 p-6 shadow-sm">
                <h4 className="font-display font-semibold text-cail-dark text-[15px] mb-3">Version history</h4>
                <p className="text-sm text-gray-500 leading-relaxed">
                  Every save creates a version snapshot. Browse previous versions with a visual diff, see who
                  made each change, and revert to any earlier state with one click. Available in the Review tab
                  of both editors.
                </p>
              </div>

              <div className="bg-white rounded-2xl border border-gray-100 p-6 shadow-sm">
                <h4 className="font-display font-semibold text-cail-dark text-[15px] mb-3">Split &amp; merge</h4>
                <p className="text-sm text-gray-500 leading-relaxed">
                  Reorganize your documents after OCR. Split a text into multiple parts by assigning pages
                  to groups, or merge several texts into one. Useful when page order needs adjusting or
                  when separate scans belong to the same document.
                </p>
              </div>
            </div>
          </RevealSection>
        </div>
      </section>

      {/* ============================================================ */}
      {/*  QUICK REFERENCE                                             */}
      {/* ============================================================ */}
      <section className="relative bg-white">
        <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-cail-blue/20 to-transparent" />

        <div className="max-w-5xl mx-auto px-6 sm:px-8 py-20 sm:py-28">
          <RevealSection>
            <p className="font-display text-xs font-semibold uppercase tracking-[0.2em] text-cail-teal mb-4">Quick reference</p>
            <h2 className="font-display font-bold text-2xl sm:text-3xl text-cail-dark max-w-2xl leading-tight">
              Supported formats &amp; limits
            </h2>
          </RevealSection>

          <RevealSection delay={100}>
            <div className="mt-10 overflow-hidden rounded-2xl border border-gray-100 overflow-x-auto">
              <table className="w-full text-sm min-w-[400px]">
                <thead>
                  <tr className="bg-gray-50 text-left">
                    <th className="px-5 py-3 font-display font-semibold text-cail-dark text-xs uppercase tracking-wider">Category</th>
                    <th className="px-5 py-3 font-display font-semibold text-cail-dark text-xs uppercase tracking-wider">Details</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  <tr>
                    <td className="px-5 py-3 text-gray-600 font-medium">Image formats</td>
                    <td className="px-5 py-3 text-gray-500">JPEG, PNG, TIFF, BMP, WebP, HEIC/HEIF</td>
                  </tr>
                  <tr>
                    <td className="px-5 py-3 text-gray-600 font-medium">PDF upload</td>
                    <td className="px-5 py-3 text-gray-500">Any PDF — rasterized for Image-to-Markdown, parsed natively for PDF-to-HTML</td>
                  </tr>
                  <tr>
                    <td className="px-5 py-3 text-gray-600 font-medium">Storage quota</td>
                    <td className="px-5 py-3 text-gray-500">50 MB per user (uploaded images and PDFs)</td>
                  </tr>
                  <tr>
                    <td className="px-5 py-3 text-gray-600 font-medium">Math notation</td>
                    <td className="px-5 py-3 text-gray-500">TeX/LaTeX rendered with KaTeX; converted to MathML at export</td>
                  </tr>
                  <tr>
                    <td className="px-5 py-3 text-gray-600 font-medium">Languages</td>
                    <td className="px-5 py-3 text-gray-500">40+ languages for OCR and translation</td>
                  </tr>
                  <tr>
                    <td className="px-5 py-3 text-gray-600 font-medium">Project expiry</td>
                    <td className="px-5 py-3 text-gray-500">Projects expire after 90 days — export your work before then</td>
                  </tr>
                  <tr>
                    <td className="px-5 py-3 text-gray-600 font-medium">Export format</td>
                    <td className="px-5 py-3 text-gray-500">ZIP archive with Markdown or HTML + images, ready for Manifold ingestion</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </RevealSection>
        </div>
      </section>

      {/* ============================================================ */}
      {/*  FOOTER CTA                                                  */}
      {/* ============================================================ */}
      <section className="relative overflow-hidden bg-gradient-to-br from-cail-navy via-[#1a3370] to-[#142a5c] text-white">
        <div
          className="absolute inset-0 opacity-[0.04] pointer-events-none"
          style={{ backgroundImage: `url("${NOISE_SVG}")` }}
        />
        <div className="absolute -left-20 -top-20 opacity-[0.04] pointer-events-none">
          <ManifoldLogo className="w-[300px] h-[300px]" />
        </div>

        <div className="relative max-w-5xl mx-auto px-6 sm:px-8 py-16 sm:py-20 text-center">
          <RevealSection>
            <h2 className="font-display font-bold text-2xl sm:text-3xl">Ready to digitize?</h2>
            <Link
              to="/"
              className="inline-flex items-center gap-2 mt-8 px-8 py-3.5 rounded-full bg-white text-cail-navy font-display font-semibold text-sm hover:bg-cail-teal hover:text-white transition-all duration-300 shadow-lg shadow-black/20"
            >
              Go to Dashboard
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8l4 4m0 0l-4 4m4-4H3" />
              </svg>
            </Link>
          </RevealSection>

          <RevealSection delay={100}>
            <p className="mt-8 text-sm text-blue-100/60">
              Questions or feedback?{' '}
              <a href="mailto:ailab@gc.cuny.edu" className="text-cail-teal hover:text-white underline underline-offset-4 decoration-cail-teal/40 hover:decoration-white/60 transition-colors">
                ailab@gc.cuny.edu
              </a>
            </p>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-3 sm:gap-6 text-xs text-blue-200/50">
              <a href="https://cuny.manifoldapp.org/" target="_blank" rel="noopener noreferrer" className="hover:text-white transition-colors">CUNY Manifold</a>
              <span>&middot;</span>
              <a href="https://gc.cuny.edu/" target="_blank" rel="noopener noreferrer" className="hover:text-white transition-colors">The Graduate Center, CUNY</a>
              <span>&middot;</span>
              <span>Built by CUNY AI Lab</span>
            </div>
          </RevealSection>
        </div>
      </section>
    </div>
  );
}
