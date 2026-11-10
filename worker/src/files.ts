// Serving stored objects. The content type is chosen HERE from the kind the
// route asked for, never from what the object (or its uploader) claims, and
// every response is nosniff. Stored HTML is never served as an app page: it is
// only ever fetched as data or shown in a sandboxed iframe.

export type FileKind = "image-png" | "image-jpeg" | "image-webp" | "image-gif" | "pdf" | "html" | "markdown" | "text" | "json" | "zip";

const KINDS: Record<FileKind, { type: string; disposition: "inline" | "attachment" }> = {
  "image-png": { type: "image/png", disposition: "inline" },
  "image-jpeg": { type: "image/jpeg", disposition: "inline" },
  "image-webp": { type: "image/webp", disposition: "inline" },
  "image-gif": { type: "image/gif", disposition: "inline" },
  pdf: { type: "application/pdf", disposition: "inline" },
  html: { type: "text/html; charset=utf-8", disposition: "attachment" },
  markdown: { type: "text/markdown; charset=utf-8", disposition: "attachment" },
  text: { type: "text/plain; charset=utf-8", disposition: "inline" },
  json: { type: "application/json", disposition: "inline" },
  zip: { type: "application/zip", disposition: "attachment" },
};

export function serveBody(body: BodyInit | null, kind: FileKind, filename: string): Response {
  const k = KINDS[kind];
  const safeName = filename.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100) || "file";
  return new Response(body, {
    headers: {
      "content-type": k.type,
      "content-disposition": `${k.disposition}; filename="${safeName}"`,
      "x-content-type-options": "nosniff",
      "cache-control": "private, no-store",
      // Even if a browser renders it, it gets an opaque origin and no powers.
      "content-security-policy": "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'",
      "cross-origin-resource-policy": "same-origin",
    },
  });
}
