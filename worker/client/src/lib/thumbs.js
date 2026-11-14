// Page thumbnails for the page list, made in the browser from the page image
// (the Worker cannot resize, and storing them would add an object per page to
// quotas, copies and moves). Made lazily when a row scrolls into view, at
// most a few at a time, and kept for the session as small blob: URLs.
export const THUMB_EDGE = 96;

/** Width and height that fit within `max` on the long side, never enlarging. */
export function fitWithin(width, height, max = THUMB_EDGE) {
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Run async jobs with at most `limit` at once, in the order they were asked for. */
export function makeQueue(limit = 3) {
  let running = 0;
  const waiting = [];
  const next = () => {
    if (running >= limit || waiting.length === 0) return;
    running += 1;
    const { job, resolve, reject } = waiting.shift();
    Promise.resolve().then(job).then(resolve, reject).finally(() => { running -= 1; next(); });
  };
  return (job) => new Promise((resolve, reject) => { waiting.push({ job, resolve, reject }); next(); });
}

const cache = new Map(); // page id -> Promise<string | null> (blob: URL)
const queue = makeQueue(3);

async function draw(blob) {
  const bitmap = await createImageBitmap(blob);
  const { width, height } = fitWithin(bitmap.width, bitmap.height, THUMB_EDGE * 2); // 2x for sharp screens
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();
  const out = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.75));
  return out ? URL.createObjectURL(out) : null;
}

/** The thumbnail URL of a page (null if it cannot be made); `fetchImage` returns the page image as a Blob. */
export function thumbnailFor(pageId, fetchImage) {
  if (!cache.has(pageId)) {
    const made = queue(async () => draw(await fetchImage())).catch(() => null);
    cache.set(pageId, made);
    made.then((url) => { if (url === null) cache.delete(pageId); });
  }
  return cache.get(pageId);
}
