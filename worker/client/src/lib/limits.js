// Checks made in the browser before a PDF is rasterised or uploaded, against the
// limits the Worker publishes in /session, so a PDF that cannot fit is refused
// at once instead of after pages were drawn and sent one by one. The Worker
// still enforces every limit; these only say it early.
import { api } from '../api/client';
import { formatBytes } from '../components/ui';

/** A low estimate of one rasterised page (JPEG): refusing on it means the PDF certainly does not fit. */
export const MIN_PAGE_BYTES = 100 * 1024;

/** Why a PDF of `pdfPages` pages cannot become pages of this project, or null when it can. Pure. */
export function pdfPagesProblem({ name, pdfPages, pageCount, maxPages, usedBytes, quotaBytes }) {
  const room = Math.max(0, maxPages - pageCount);
  if (pdfPages > room) return `${name} has ${pdfPages} pages, and this project has room for ${room} more (a project holds at most ${maxPages} pages). Nothing was uploaded. Split the PDF, or put the rest in another project.`;
  const free = Math.max(0, quotaBytes - usedBytes);
  if (pdfPages * MIN_PAGE_BYTES > free) return `${name} would need at least ${formatBytes(pdfPages * MIN_PAGE_BYTES)} as page images, and ${formatBytes(free)} of your storage is free. Nothing was uploaded. Delete pages or versions you no longer need, or export and delete an old project.`;
  return null;
}

/** Why a PDF file cannot be stored as a text's source PDF, or null. Pure. */
export function pdfFileProblem({ name, bytes, maxPdfBytes, usedBytes, quotaBytes }) {
  if (bytes > maxPdfBytes) return `${name} is ${formatBytes(bytes)}; a source PDF can be at most ${formatBytes(maxPdfBytes)}. Nothing was uploaded.`;
  const free = Math.max(0, quotaBytes - usedBytes);
  if (bytes > free) return `${name} is ${formatBytes(bytes)}, and ${formatBytes(free)} of your storage is free. Nothing was uploaded.`;
  return null;
}

/** Throws (as an error the page shows) when a PDF of `pdfPages` pages cannot be added to the project. */
export async function checkPdfFits({ session, projectId, name, pdfPages }) {
  if (!session?.limits || !session.storage) return;
  const { project } = await api.get(`/api/projects/${projectId}`);
  // Storage counts against the project's owner; the session's numbers are the caller's, so only the owner gets the storage check.
  const own = project.role === 'owner';
  const message = pdfPagesProblem({ name, pdfPages, pageCount: project.page_count ?? 0, maxPages: session.limits.max_project_pages, usedBytes: own ? session.storage.used_bytes : 0, quotaBytes: own ? session.storage.quota_bytes : Infinity });
  if (message) throw Object.assign(new Error(message), { code: 'pdf_does_not_fit' });
}
