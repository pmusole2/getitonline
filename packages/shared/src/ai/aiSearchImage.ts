// The rules for a photo sent to visual search. The client keeps the photo within the same limit the backend enforces, so a
// large photo is shrunk here rather than refused by the server. The data URL limit mirrors MAX_IMAGE_DATA_URL_LENGTH in
// convex/lib/aiProvider.ts, and the prefix and base64 rule mirror isSupportedImageDataUrl there.

export const VISUAL_SEARCH_MAX_SOURCE_BYTES = 10 * 1024 * 1024;
export const VISUAL_SEARCH_MAX_DATA_URL_LENGTH = 500_000;
export const VISUAL_SEARCH_MAX_EDGE = 512;

// Tried in order. The first encode that fits the limit is sent, so a smaller file costs more compression, not a refusal.
const QUALITY_STEPS: readonly number[] = [0.7, 0.55, 0.4, 0.25];
const IMAGE_DATA_URL_PREFIX = /^data:image\/(?:png|jpeg|webp|gif);base64,/;
// The base64 characters without padding. Padding is checked on its own, as isValidBase64Payload does in the backend.
const BASE64_CHARACTERS = /^[A-Za-z0-9+/]+$/;

// The message is for the person, so the page shows it as it is.
export class VisualSearchImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VisualSearchImageError";
  }
}

export interface ImageSize {
  readonly width: number;
  readonly height: number;
}

// Refused before the file is decoded, so an oversized or non-image file costs no memory.
export function assertVisualSearchFile(file: {
  size: number;
  type: string;
}): void {
  if (!file.type.startsWith("image/")) {
    throw new VisualSearchImageError("Select an image file.");
  }
  if (file.size > VISUAL_SEARCH_MAX_SOURCE_BYTES) {
    throw new VisualSearchImageError("Choose an image under 10 MB.");
  }
}

// Scales the photo so its longer edge is at most VISUAL_SEARCH_MAX_EDGE. A photo that is already small is not enlarged.
export function visualSearchSize(natural: ImageSize): ImageSize {
  const longest = Math.max(natural.width, natural.height);
  const scale = Math.min(1, VISUAL_SEARCH_MAX_EDGE / longest);
  return {
    width: Math.max(1, Math.round(natural.width * scale)),
    height: Math.max(1, Math.round(natural.height * scale)),
  };
}

// Structural check of a standard base64 payload, the same rule as isValidBase64Payload in convex/lib/aiProvider.ts:
// non-empty, a multiple of 4, '=' only as up to two trailing characters, and no other characters.
function isStandardBase64Payload(payload: string): boolean {
  if (payload.length === 0 || payload.length % 4 !== 0) {
    return false;
  }
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  const body = payload.slice(0, payload.length - padding);
  return body.length > 0 && BASE64_CHARACTERS.test(body);
}

// True only for a base64 image data URL that the backend accepts.
export function isVisualSearchDataUrl(value: string): boolean {
  if (value.length > VISUAL_SEARCH_MAX_DATA_URL_LENGTH) {
    return false;
  }
  const prefix = IMAGE_DATA_URL_PREFIX.exec(value);
  return (
    prefix !== null && isStandardBase64Payload(value.slice(prefix[0].length))
  );
}

// Encodes the photo at the bounded size, lowering JPEG quality until the data URL fits. A photo that still does not fit
// is refused, never sent. `encode` is the canvas step, which the page supplies.
export function encodeVisualSearchImage(
  natural: ImageSize,
  encode: (size: ImageSize, quality: number) => string,
): string {
  const size = visualSearchSize(natural);
  for (const quality of QUALITY_STEPS) {
    const url = encode(size, quality);
    if (isVisualSearchDataUrl(url)) {
      return url;
    }
  }
  throw new VisualSearchImageError(
    "This photo is too detailed for image search. Try a smaller photo.",
  );
}
