# Manifold Companion

A document-processing platform built by the [CUNY AI Lab](https://gc.cuny.edu/) that transforms scanned pages, historical manuscripts, and digital PDFs into publication-ready texts for [CUNY's Manifold instance](https://cuny.manifoldapp.org/).

## Workflows

**Image to Markdown** — Upload images (JPEG, PNG, TIFF, BMP, WebP, HEIC) or rasterized PDFs. AI-powered OCR extracts text into editable Markdown. Review and correct page by page, then export.

**PDF to HTML** — Upload a digital PDF and the platform converts it to structured HTML preserving headings, tables, lists, and mathematical formulas (TeX/KaTeX). Edit in a rich-text editor, then export.

Both workflows include AI-powered summaries and translations (40+ languages), Dublin Core metadata, version history, and ZIP export ready for Manifold ingestion.

## Tech Stack

- **Backend**: Express 4, better-sqlite3, express-session
- **Frontend**: React 18, React Router 6, Tailwind CSS 3, KaTeX
- **AI/OCR**: AWS Bedrock (Image-to-Markdown pipeline), Google Gemini via OpenRouter (PDF-to-HTML pipeline)
- **Infrastructure**: SQLite with WAL mode, AWS SES for email notifications

Both AI providers operate under zero data retention policies.

## Getting Started

```bash
# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env with your AWS credentials, OpenRouter API key, session secret, etc.

# Development (starts both server and client)
npm run dev

# Production build
npm run build
npm start
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `SESSION_SECRET` | Express session secret (>=32 chars in production) |
| `AWS_REGION` | AWS region for Bedrock and SES |
| `BEDROCK_OCR_MODEL` | Vision model ID for OCR |
| `BEDROCK_TEXT_MODEL` | Text model ID for summaries/translations |
| `OPENROUTER_API_KEY` | API key for OpenRouter |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | Seeds initial admin user |
| `SES_FROM_EMAIL` | SES verified sender address |
| `APP_URL` | Public app URL for email links |

## Features

- **OCR**: AI vision model extracts text from scans, photos, and handwritten pages
- **Rich editing**: Side-by-side page image and text editor (Markdown or HTML)
- **Collaboration**: Share projects with editors/viewers, threaded annotations with @mentions
- **Notifications**: In-app bell + optional email alerts for OCR completion, shares, replies, mentions
- **Version history**: Every save creates a snapshot with visual diff and one-click revert
- **Split & merge**: Reorganize documents by splitting or merging texts
- **Search**: Full-text search across all owned and shared projects
- **Math support**: TeX input rendered with KaTeX, converted to MathML at Manifold export
- **Metadata**: Dublin Core fields for scholarly cataloging
- **Export**: ZIP archives with structured content and images for Manifold import

## Project Structure

```
server/           Express API (port 3000)
  routes/         Route handlers (auth, projects, texts, ocr, llm, export, shares, annotations, notifications)
  services/       AI services (bedrock, openrouter), email, storage, cleanup
  middleware/     Auth, CSRF, rate limits, access control, upload validation
client/           React + Vite SPA
  src/pages/      Page components (Dashboard, ProjectView, TextDetail, etc.)
  src/components/ Shared components (Header, Footer, SharePanel, AnnotationSidebar, etc.)
  src/api/        API client
  src/lib/        PDF conversion pipeline
data/             Runtime data (SQLite DBs, uploaded files) — gitignored
```

## License

All rights reserved. CUNY AI Lab, The Graduate Center, City University of New York.

## Contact

[ailab@gc.cuny.edu](mailto:ailab@gc.cuny.edu)
