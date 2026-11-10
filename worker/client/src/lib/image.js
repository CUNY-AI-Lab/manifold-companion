// Image preparation in the browser (replaces the server's sharp step). The
// Worker never decodes images: it checks magic bytes, so everything is
// normalised here to an upright JPEG no larger than 2048 px on its long side.

export const MAX_DIMENSION = 2048;

const isHeic = (file) => /image\/hei[cf]/i.test(file.type) || /\.hei[cf]$/i.test(file.name);

async function decode(file) {
  let source = file;
  if (isHeic(file)) {
    const { default: heic2any } = await import('heic2any');
    source = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.92 });
  }
  // from-image applies the EXIF orientation, so phone photos come out upright.
  return createImageBitmap(source, { imageOrientation: 'from-image' });
}

/** Fit (w, h) into maxDim on the long side, never upscaling. */
export function fitWithin(w, h, maxDim = MAX_DIMENSION) {
  const scale = Math.min(1, maxDim / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

/** Rotation in quarter turns: 0, 90, 180, 270. Returns the canvas size for a rotated image. */
export function rotatedSize(w, h, degrees) {
  return degrees % 180 === 0 ? { width: w, height: h } : { width: h, height: w };
}

const toBlob = (canvas, type, quality) => new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode_failed'))), type, quality));

/**
 * Decode, rotate (0/90/180/270), resize and re-encode as JPEG, lowering the
 * quality until the result fits `maxBytes`.
 */
export async function prepareImage(file, { rotate = 0, maxDim = MAX_DIMENSION, maxBytes = 10 * 1024 * 1024 } = {}) {
  const bitmap = await decode(file);
  const fitted = fitWithin(bitmap.width, bitmap.height, maxDim);
  const size = rotatedSize(fitted.width, fitted.height, rotate);
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, size.width, size.height);
  ctx.translate(size.width / 2, size.height / 2);
  ctx.rotate((rotate * Math.PI) / 180);
  ctx.drawImage(bitmap, -fitted.width / 2, -fitted.height / 2, fitted.width, fitted.height);
  bitmap.close?.();
  for (const quality of [0.9, 0.8, 0.7, 0.55, 0.4]) {
    const blob = await toBlob(canvas, 'image/jpeg', quality);
    if (blob.size <= maxBytes) return { blob, width: size.width, height: size.height };
  }
  throw new Error('image_too_large');
}

export const jpegName = (name) => `${name.replace(/\.[^.]+$/, '') || 'page'}.jpg`;

export function blobToDataUri(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
