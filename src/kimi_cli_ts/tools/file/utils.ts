/**
 * File type detection utilities.
 * Corresponds to Python tools/file/utils.py
 */

import { extname } from "node:path";

export const MEDIA_SNIFF_BYTES = 512;

export interface FileType {
	kind: "text" | "image" | "video" | "unknown";
	mimeType: string;
}

const IMAGE_MIME_BY_SUFFIX: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".bmp": "image/bmp",
	".tif": "image/tiff",
	".tiff": "image/tiff",
	".webp": "image/webp",
	".ico": "image/x-icon",
	".heic": "image/heic",
	".heif": "image/heif",
	".avif": "image/avif",
	".svgz": "image/svg+xml",
};

const VIDEO_MIME_BY_SUFFIX: Record<string, string> = {
	".mp4": "video/mp4",
	".mkv": "video/x-matroska",
	".avi": "video/x-msvideo",
	".mov": "video/quicktime",
	".wmv": "video/x-ms-wmv",
	".webm": "video/webm",
	".m4v": "video/x-m4v",
	".flv": "video/x-flv",
	".3gp": "video/3gpp",
	".3g2": "video/3gpp2",
};

const TEXT_MIME_BY_SUFFIX: Record<string, string> = {
	".svg": "image/svg+xml",
};

const FTYP_IMAGE_BRANDS: Record<string, string> = {
	avif: "image/avif",
	avis: "image/avif",
	heic: "image/heic",
	heif: "image/heif",
	heix: "image/heif",
	hevc: "image/heic",
	mif1: "image/heif",
	msf1: "image/heif",
};

const FTYP_VIDEO_BRANDS: Record<string, string> = {
	isom: "video/mp4",
	iso2: "video/mp4",
	iso5: "video/mp4",
	mp41: "video/mp4",
	mp42: "video/mp4",
	avc1: "video/mp4",
	mp4v: "video/mp4",
	m4v: "video/x-m4v",
	qt: "video/quicktime",
	"3gp4": "video/3gpp",
	"3gp5": "video/3gpp",
	"3gp6": "video/3gpp",
	"3gp7": "video/3gpp",
	"3g2": "video/3gpp2",
};

const NON_TEXT_SUFFIXES = new Set([
	".icns",
	".psd",
	".ai",
	".eps",
	// Documents / office formats
	".pdf",
	".doc",
	".docx",
	".dot",
	".dotx",
	".rtf",
	".odt",
	".xls",
	".xlsx",
	".xlsm",
	".xlt",
	".xltx",
	".xltm",
	".ods",
	".ppt",
	".pptx",
	".pptm",
	".pps",
	".ppsx",
	".odp",
	".pages",
	".numbers",
	".key",
	// Archives / compressed
	".zip",
	".rar",
	".7z",
	".tar",
	".gz",
	".tgz",
	".bz2",
	".xz",
	".zst",
	".lz",
	".lz4",
	".br",
	".cab",
	".ar",
	".deb",
	".rpm",
	// Audio
	".mp3",
	".wav",
	".flac",
	".ogg",
	".oga",
	".opus",
	".aac",
	".m4a",
	".wma",
	// Fonts
	".ttf",
	".otf",
	".woff",
	".woff2",
	// Binaries / bundles
	".exe",
	".dll",
	".so",
	".dylib",
	".bin",
	".apk",
	".ipa",
	".jar",
	".class",
	".pyc",
	".pyo",
	".wasm",
	// Disk images / databases
	".dmg",
	".iso",
	".img",
	".sqlite",
	".sqlite3",
	".db",
	".db3",
]);

const ASF_HEADER = new Uint8Array([
	0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11, 0xa6, 0xd9, 0x00, 0xaa, 0x00,
	0x62, 0xce, 0x6c,
]);

function bufStartsWith(
	buf: Uint8Array,
	prefix: Uint8Array | number[],
): boolean {
	if (buf.length < prefix.length) return false;
	for (let i = 0; i < prefix.length; i++) {
		if (buf[i] !== prefix[i]) return false;
	}
	return true;
}

function sniffFtypBrand(header: Uint8Array): string | null {
	if (header.length < 12) return null;
	// Check for "ftyp" at bytes 4-8
	if (
		header[4] !== 0x66 || // f
		header[5] !== 0x74 || // t
		header[6] !== 0x79 || // y
		header[7] !== 0x70 // p
	)
		return null;
	const brand = String.fromCharCode(...header.slice(8, 12))
		.toLowerCase()
		.trim();
	return brand;
}

/** Detect media type from raw magic bytes. */
export function sniffMediaFromMagic(data: Uint8Array): FileType | null {
	const header = data.slice(0, MEDIA_SNIFF_BYTES);

	// PNG
	if (bufStartsWith(header, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
		return { kind: "image", mimeType: "image/png" };
	}
	// JPEG
	if (bufStartsWith(header, [0xff, 0xd8, 0xff])) {
		return { kind: "image", mimeType: "image/jpeg" };
	}
	// GIF
	if (
		bufStartsWith(header, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || // GIF87a
		bufStartsWith(header, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
	) {
		// GIF89a
		return { kind: "image", mimeType: "image/gif" };
	}
	// BMP
	if (bufStartsWith(header, [0x42, 0x4d])) {
		return { kind: "image", mimeType: "image/bmp" };
	}
	// TIFF (II or MM)
	if (
		bufStartsWith(header, [0x49, 0x49, 0x2a, 0x00]) ||
		bufStartsWith(header, [0x4d, 0x4d, 0x00, 0x2a])
	) {
		return { kind: "image", mimeType: "image/tiff" };
	}
	// ICO
	if (bufStartsWith(header, [0x00, 0x00, 0x01, 0x00])) {
		return { kind: "image", mimeType: "image/x-icon" };
	}
	// RIFF (WEBP or AVI)
	if (bufStartsWith(header, [0x52, 0x49, 0x46, 0x46]) && header.length >= 12) {
		const chunk = String.fromCharCode(
			header[8]!,
			header[9]!,
			header[10]!,
			header[11]!,
		);
		if (chunk === "WEBP") return { kind: "image", mimeType: "image/webp" };
		if (chunk === "AVI ") return { kind: "video", mimeType: "video/x-msvideo" };
	}
	// FLV
	if (bufStartsWith(header, [0x46, 0x4c, 0x56])) {
		return { kind: "video", mimeType: "video/x-flv" };
	}
	// ASF (WMV)
	if (bufStartsWith(header, ASF_HEADER)) {
		return { kind: "video", mimeType: "video/x-ms-wmv" };
	}
	// WebM / Matroska
	if (bufStartsWith(header, [0x1a, 0x45, 0xdf, 0xa3])) {
		const lowered = new TextDecoder().decode(header).toLowerCase();
		if (lowered.includes("webm"))
			return { kind: "video", mimeType: "video/webm" };
		if (lowered.includes("matroska"))
			return { kind: "video", mimeType: "video/x-matroska" };
	}
	// ftyp container (MP4, HEIC, AVIF, etc.)
	const brand = sniffFtypBrand(header);
	if (brand) {
		if (brand in FTYP_IMAGE_BRANDS) {
			return { kind: "image", mimeType: FTYP_IMAGE_BRANDS[brand]! };
		}
		if (brand in FTYP_VIDEO_BRANDS) {
			return { kind: "video", mimeType: FTYP_VIDEO_BRANDS[brand]! };
		}
	}

	return null;
}

/** Detect file type from path extension and optional header bytes. */
export function detectFileType(path: string, header?: Uint8Array): FileType {
	const suffix = extname(path).toLowerCase();

	let mediaHint: FileType | null = null;
	if (suffix in TEXT_MIME_BY_SUFFIX) {
		mediaHint = { kind: "text", mimeType: TEXT_MIME_BY_SUFFIX[suffix]! };
	} else if (suffix in IMAGE_MIME_BY_SUFFIX) {
		mediaHint = { kind: "image", mimeType: IMAGE_MIME_BY_SUFFIX[suffix]! };
	} else if (suffix in VIDEO_MIME_BY_SUFFIX) {
		mediaHint = { kind: "video", mimeType: VIDEO_MIME_BY_SUFFIX[suffix]! };
	}

	if (mediaHint && (mediaHint.kind === "image" || mediaHint.kind === "video")) {
		return mediaHint;
	}

	if (header !== undefined) {
		const sniffed = sniffMediaFromMagic(header);
		if (sniffed) {
			if (mediaHint && sniffed.kind !== mediaHint.kind) {
				return { kind: "unknown", mimeType: "" };
			}
			return sniffed;
		}
		// NUL bytes are a strong signal of binary content
		if (header.includes(0x00)) {
			return { kind: "unknown", mimeType: "" };
		}
	}

	if (mediaHint) return mediaHint;
	if (NON_TEXT_SUFFIXES.has(suffix)) {
		return { kind: "unknown", mimeType: "" };
	}
	return { kind: "text", mimeType: "text/plain" };
}
