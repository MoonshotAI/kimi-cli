---
name: monoco_atom_doc_extract
description: Extract documents to WebP pages for VLM analysis - Convert PDF, Office, Images to standardized WebP format
type: atom
---

## Document Extraction

Extract documents to WebP pages suitable for Vision Language Model (VLM) analysis.

### When to Use

Use this skill when you need to:
- Analyze PDF documents with visual capabilities
- Process Office documents (DOCX, PPTX, XLSX) for content extraction
- Convert images or scanned documents to page sequences
- Handle documents from ZIP archives

### Commands

**Extract a document:**

```bash
monoco doc-extractor extract <file_path> [--dpi 150] [--quality 85] [--pages "1-5,10"]
```

**List extracted documents:**

```bash
monoco doc-extractor list [--category pdf] [--limit 20]
```

**Search documents:**

```bash
monoco doc-extractor search <query>
```

**Show document details:**

```bash
monoco doc-extractor show <hash_prefix>
monoco doc-extractor cat <hash_prefix>  # Show metadata JSON
```

### Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `--dpi` | 150 | DPI for rendering (72-300) |
| `--quality` | 85 | WebP quality (1-100) |
| `--pages` | all | Page range (e.g., "1-5,10,15-20") |

### Output

Documents are stored in `~/.monoco/blobs/{sha256_hash}/`:
- `source.{ext}` - Original file
- `source.pdf` - Normalized PDF
- `pages/*.webp` - Rendered page images
- `meta.json` - Document metadata

### Example

```bash
# Extract a PDF with high quality
monoco doc-extractor extract ./report.pdf --dpi 200 --quality 90

# Extract specific pages from a document
monoco doc-extractor extract ./presentation.pptx --pages "1-10"

# List all PDF documents
monoco doc-extractor list --category pdf

# Show details of extracted document
monoco doc-extractor show a1b2c3d4
```

### Best Practices

- Use `--dpi 200` or higher for documents with small text
- Use `--quality 90` for better image quality (larger files)
- Extracted documents are cached by content hash - re-extraction is instant
- Archives (ZIP) are automatically extracted and processed
