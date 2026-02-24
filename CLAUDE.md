# Manifold Companion

Multi-user OCR platform for manuscript digitization. Built with Express backend, React/Vite frontend, SQLite database, and AWS Bedrock for AI-powered OCR and text processing.

## Monorepo Structure

- **Root** -- npm workspace orchestrator
- **`server/`** -- Express API server (port 3000), handles auth, file uploads, OCR via Bedrock, SQLite storage
- **`client/`** -- React + Vite SPA with Tailwind CSS, communicates with server API
- **`docs/`** -- Design documents and project plans
- **`data/`** -- Runtime directory for SQLite DB and uploaded files (gitignored)

## Dev Commands

```bash
npm install          # Install all workspace dependencies (run from root)
npm run dev          # Start both server and client in dev mode (concurrently)
npm run dev:server   # Start only the Express server with --watch
npm run dev:client   # Start only the Vite dev server
npm run build        # Build the client for production
npm start            # Start the production server
```

## Tech Stack

- **Backend**: Express 4, better-sqlite3, express-session, bcrypt, multer, sharp, helmet
- **Frontend**: React 18, React Router 6, Tailwind CSS 3, marked, DOMPurify, pdfjs-dist
- **AI/OCR**: AWS Bedrock (Nova Pro for OCR, Claude 3.5 Sonnet for text processing)
- **Database**: SQLite with WAL mode, foreign keys enabled

## Environment

Configuration via `.env` in project root. Required variables:
- `PORT` -- Server port (default 3000)
- `SESSION_SECRET` -- Express session secret
- `AWS_REGION` -- AWS region for Bedrock
- `BEDROCK_OCR_MODEL` -- Model ID for OCR processing
- `BEDROCK_TEXT_MODEL` -- Model ID for text processing (summaries, translations)
