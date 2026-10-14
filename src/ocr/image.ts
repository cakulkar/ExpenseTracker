/**
 * Local image handling with browser APIs only: validation, EXIF orientation, rotate, crop,
 * contrast enhancement for OCR, resizing and thumbnails. Nothing leaves the device here.
 */

export const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
export const MAX_EDGE = 2000;

export function validateImageFile(file: { type: string; size: number; name?: string }): string | null {
  if (!ACCEPTED_TYPES.includes(file.type)) {
    if (/heic|heif/i.test(file.type) || /\.hei[cf]$/i.test(file.name ?? '')) {
      return 'HEIC photos can’t be read by this browser. On iPhone, the camera button here takes a JPEG automatically; or set Settings → Camera → Formats → Most Compatible.';
    }
    return 'Use a JPEG, PNG or WebP image.';
  }
  if (file.size > MAX_IMAGE_BYTES) return 'This image is larger than 15 MB. Take a new photo or use a smaller file.';
  if (file.size === 0) return 'This file is empty.';
  return null;
}

export type Rotation = 0 | 90 | 180 | 270;

/** Normalized crop rectangle (0–1) on the rotated image. */
export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const FULL_CROP: CropRect = { x: 0, y: 0, w: 1, h: 1 };

/** Decode with EXIF orientation applied (phone photos are often stored sideways). */
export async function decodeImage(blob: Blob): Promise<ImageBitmap | HTMLImageElement> {
  if ('createImageBitmap' in window) {
    try {
      return await createImageBitmap(blob, { imageOrientation: 'from-image' });
    } catch {
      /* fall through */
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function size(img: ImageBitmap | HTMLImageElement): { w: number; h: number } {
  return 'naturalWidth' in img ? { w: img.naturalWidth, h: img.naturalHeight } : { w: img.width, h: img.height };
}

/** Draw rotated + cropped + resized into a canvas. */
export function renderTransformed(img: ImageBitmap | HTMLImageElement, rotation: Rotation, crop: CropRect, maxEdge = MAX_EDGE): HTMLCanvasElement {
  const { w, h } = size(img);
  const rw = rotation % 180 === 0 ? w : h;
  const rh = rotation % 180 === 0 ? h : w;
  // full rotated image
  const rot = document.createElement('canvas');
  rot.width = rw;
  rot.height = rh;
  const rc = rot.getContext('2d')!;
  rc.translate(rw / 2, rh / 2);
  rc.rotate((rotation * Math.PI) / 180);
  rc.drawImage(img, -w / 2, -h / 2);
  // crop + resize
  const cx = Math.round(crop.x * rw);
  const cy = Math.round(crop.y * rh);
  const cw = Math.max(1, Math.round(crop.w * rw));
  const ch = Math.max(1, Math.round(crop.h * rh));
  const scale = Math.min(1, maxEdge / Math.max(cw, ch));
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(cw * scale));
  out.height = Math.max(1, Math.round(ch * scale));
  const oc = out.getContext('2d')!;
  oc.imageSmoothingQuality = 'high';
  oc.drawImage(rot, cx, cy, cw, ch, 0, 0, out.width, out.height);
  rot.width = rot.height = 0; // free memory early on phones
  return out;
}

/**
 * Grayscale + contrast stretch (2nd–98th percentile). Pure function over RGBA data, unit-testable.
 */
export function enhancePixels(data: Uint8ClampedArray): void {
  const hist = new Uint32Array(256);
  const n = data.length / 4;
  for (let i = 0; i < data.length; i += 4) {
    const g = Math.round(0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!);
    data[i] = data[i + 1] = data[i + 2] = g;
    hist[g]!++;
  }
  let lo = 0;
  let hi = 255;
  let acc = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v]!;
    if (acc >= n * 0.02) {
      lo = v;
      break;
    }
  }
  acc = 0;
  for (let v = 255; v >= 0; v--) {
    acc += hist[v]!;
    if (acc >= n * 0.02) {
      hi = v;
      break;
    }
  }
  if (hi - lo < 10) return;
  const scale = 255 / (hi - lo);
  for (let i = 0; i < data.length; i += 4) {
    const v = Math.max(0, Math.min(255, Math.round((data[i]! - lo) * scale)));
    data[i] = data[i + 1] = data[i + 2] = v;
  }
}

export function enhancedCopy(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = src.width;
  c.height = src.height;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(src, 0, 0);
  const img = ctx.getImageData(0, 0, c.width, c.height);
  enhancePixels(img.data);
  ctx.putImageData(img, 0, 0);
  return c;
}

export function canvasToJpeg(c: HTMLCanvasElement, quality = 0.85): Promise<Blob> {
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode image'))), 'image/jpeg', quality));
}

export async function thumbnailOf(c: HTMLCanvasElement, maxEdge = 320): Promise<Blob> {
  const scale = Math.min(1, maxEdge / Math.max(c.width, c.height));
  const t = document.createElement('canvas');
  t.width = Math.max(1, Math.round(c.width * scale));
  t.height = Math.max(1, Math.round(c.height * scale));
  t.getContext('2d')!.drawImage(c, 0, 0, t.width, t.height);
  return canvasToJpeg(t, 0.7);
}
