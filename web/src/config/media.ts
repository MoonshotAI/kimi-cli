export const IMAGE_CONFIG = {
  maxSizeBytes: 5 * 1024 * 1024,
  maxDimension: 4096,
  compressThresholdBytes: 5 * 1024 * 1024,
  targetCompressedBytes: 2 * 1024 * 1024,
  allowedTypes: ["image/png", "image/jpeg", "image/gif", "image/webp", "image/heic", "image/heif"] as const,
} as const;

export const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "svg", "bmp"]);

export const VIDEO_CONFIG = {
  maxSizeBytes: 40 * 1024 * 1024,
  allowedTypes: ["video/mp4", "video/webm", "video/quicktime"] as const,
} as const;

export const VIDEO_EXTENSIONS = new Set(["mp4", "webm", "mov"]);

export const MEDIA_CONFIG = {
  maxCount: 9,
  maxTotalBytes: 80 * 1024 * 1024,
} as const;
