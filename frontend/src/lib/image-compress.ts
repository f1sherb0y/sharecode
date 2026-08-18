export interface CompressedImage {
  /** Data URL of the compressed image. */
  src: string
  /** Alt text derived from the original filename. */
  alt: string
}

const DEFAULT_MAX_DIMENSION = 1600
const DEFAULT_QUALITY = 0.82

function loadImage(file: File): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file)
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image()
    img.decoding = 'async'
    img.onload = () => resolve(img)
    img.onerror = () => {
      reject(new Error('Failed to decode image'))
    }
    img.src = url
  }).finally(() => {
    URL.revokeObjectURL(url)
  })
}

function toDataUrl(canvas: HTMLCanvasElement, type: string, quality: number): string | null {
  try {
    return canvas.toDataURL(type, quality)
  } catch {
    return null
  }
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'))
    reader.readAsDataURL(file)
  })
}

/**
 * Downscale + re-encode an image before it is embedded into the document.
 *
 * We prefer WebP (smallest, keeps transparency). When WebP encoding is not
 * available we fall back to JPEG (flattening transparency onto white) and,
 * as a last resort, the original file untouched.
 *
 * This runs entirely client-side so nothing ever leaves the browser; the
 * resulting data URL is what gets stored/synced in the shared document.
 */
export async function compressImageFile(
  file: File,
  maxDimension = DEFAULT_MAX_DIMENSION,
  quality = DEFAULT_QUALITY,
): Promise<CompressedImage> {
  const img = await loadImage(file)
  const sourceWidth = img.naturalWidth || img.width
  const sourceHeight = img.naturalHeight || img.height
  if (!sourceWidth || !sourceHeight) {
    return { src: await readAsDataUrl(file), alt: file.name }
  }

  const scale = Math.min(1, maxDimension / Math.max(sourceWidth, sourceHeight))
  const width = Math.max(1, Math.round(sourceWidth * scale))
  const height = Math.max(1, Math.round(sourceHeight * scale))

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    return { src: await readAsDataUrl(file), alt: file.name }
  }

  // 1. WebP (preserves alpha, best compression).
  ctx.clearRect(0, 0, width, height)
  ctx.drawImage(img, 0, 0, width, height)
  const webp = toDataUrl(canvas, 'image/webp', quality)
  if (webp && webp.startsWith('data:image/webp')) {
    return { src: webp, alt: file.name }
  }

  // 2. JPEG (no alpha → flatten onto white).
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)
  ctx.drawImage(img, 0, 0, width, height)
  const jpeg = toDataUrl(canvas, 'image/jpeg', quality)
  if (jpeg && jpeg.startsWith('data:image/jpeg')) {
    return { src: jpeg, alt: file.name }
  }

  // 3. Last resort: original file.
  return { src: await readAsDataUrl(file), alt: file.name }
}
