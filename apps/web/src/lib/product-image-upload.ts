export const MIN_PRODUCT_IMAGE_COUNT = 3;
export const MAX_PRODUCT_IMAGE_COUNT = 8;
export const MIN_PRODUCT_IMAGE_WIDTH = 1000;
export const MIN_PRODUCT_IMAGE_HEIGHT = 1000;
export const MAX_PRODUCT_IMAGE_SIZE_BYTES = 5 * 1024 * 1024;

const ACCEPTED_PRODUCT_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
]);

export interface ProductImageFileLike {
  name: string;
  type: string;
  size: number;
}

export interface ProductImageValidationResult<T extends ProductImageFileLike> {
  acceptedFiles: T[];
  errors: string[];
}

export function validateProductImageFiles<T extends ProductImageFileLike>(
  files: readonly T[],
  existingImageCount: number
): ProductImageValidationResult<T> {
  const remainingSlots = Math.max(MAX_PRODUCT_IMAGE_COUNT - existingImageCount, 0);

  if (remainingSlots === 0) {
    return {
      acceptedFiles: [],
      errors: [`You can upload up to ${MAX_PRODUCT_IMAGE_COUNT} images per listing.`],
    };
  }

  const acceptedFiles: T[] = [];
  const errors: string[] = [];

  for (const file of files) {
    if (acceptedFiles.length >= remainingSlots) {
      errors.push(`Only ${remainingSlots} more image(s) can be added to this listing.`);
      break;
    }

    if (!ACCEPTED_PRODUCT_IMAGE_TYPES.has(file.type)) {
      errors.push(`${file.name}: unsupported file type.`);
      continue;
    }

    if (file.size > MAX_PRODUCT_IMAGE_SIZE_BYTES) {
      errors.push(`${file.name}: exceeds the 5 MB upload limit.`);
      continue;
    }

    acceptedFiles.push(file);
  }

  return { acceptedFiles, errors };
}

export async function validateProductImageDimensions(
  file: File
): Promise<string | null> {
  const objectUrl = URL.createObjectURL(file);

  try {
    const dimensions = await new Promise<{ width: number; height: number }>(
      (resolve, reject) => {
        const image = new Image();
        image.onload = () =>
          resolve({ width: image.naturalWidth, height: image.naturalHeight });
        image.onerror = () => reject(new Error("Could not inspect image"));
        image.src = objectUrl;
      }
    );

    if (
      dimensions.width < MIN_PRODUCT_IMAGE_WIDTH ||
      dimensions.height < MIN_PRODUCT_IMAGE_HEIGHT
    ) {
      return `${file.name}: must be at least ${MIN_PRODUCT_IMAGE_WIDTH}x${MIN_PRODUCT_IMAGE_HEIGHT}px.`;
    }

    return null;
  } catch {
    return `${file.name}: could not be inspected.`;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
