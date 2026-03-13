---
name: monoco_atom_doc_convert
description: Document conversion and intelligent analysis - Use LibreOffice to convert Office/PDF documents to analyzable formats
type: atom
---

## Document Intelligence

When analyzing Office documents (.docx, .xlsx, .pptx, etc.) or PDFs, use this workflow.

### Core Principles

1. **No external GPU services** - Do not use MinerU or other parsing services requiring task queues
2. **Leverage existing Vision capabilities** - Kimi CLI / Claude Code have built-in visual analysis capabilities
3. **Synchronous LibreOffice calls** - Local conversion, no background services needed

### Conversion Workflow

**Step 1: Check LibreOffice Availability**

```bash
which soffice
```

**Step 2: Convert Document to PDF**

```bash
soffice --headless --convert-to pdf "{input_path}" --outdir "{output_dir}"
```

**Step 3: Use Vision Capabilities for Analysis**

The converted PDF can be directly analyzed using the Agent's visual capabilities, no additional OCR needed.

### Supported Formats

| Input Format | Conversion Method | Notes |
|-------------|-------------------|-------|
| .docx | LibreOffice → PDF | Word documents |
| .xlsx | LibreOffice → PDF | Excel spreadsheets |
| .pptx | LibreOffice → PDF | PowerPoint presentations |
| .odt | LibreOffice → PDF | OpenDocument format |
| .pdf | Use directly | No conversion needed |

### Best Practices

- **Temporary file management**: Convert output to `/tmp/` or project `.monoco/tmp/`
- **Caching strategy**: If caching parsing results is needed, use ArtifactManager for storage
- **Error handling**: Report specific error messages to users when conversion fails

### Example

Analyze a Word document:

```bash
# Convert
soffice --headless --convert-to pdf "./report.docx" --outdir "./tmp"

# Analyze (using vision capabilities)
# Then read ./tmp/report.pdf for analysis
```
