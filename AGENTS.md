# Project Instructions for Codex CLI

## CRITICAL: File Reading Performance Rules

### Files to NEVER Read or Scan
- node_modules/ - Never read dependency files
- .git/ - Never read git history
- dist/, build/, out/, .next/ - Never read build outputs
- coverage/, .nyc_output/ - Never read test coverage
- *.log, *.lock - Never read log or lock files
- pnpm-lock.yaml, package-lock.json, yarn.lock - Never read lock files
- .vercel/, .turbo/, .cache/ - Never read cache directories
- *.min.js, *.min.css, *.map - Never read minified files
- *.png, *.jpg, *.gif, *.svg, *.pdf - Never read media files
- *.woff, *.woff2, *.ttf, *.eot - Never read font files

### File Reading Strategy
1. ONLY read files directly relevant to the task
2. Use targeted searches (rg with specific patterns)
3. Read files in small chunks when possible
4. Avoid reading entire directories
5. Focus on source code files only (.ts, .tsx, .js, .jsx)

### Performance Guidelines
- Limit file reads to maximum 20 files per task
- Skip files larger than 500KB
- Use grep/rg with specific patterns instead of reading full files
- Avoid recursive directory scans
- Focus on the specific files mentioned in the task

### Workspace Scope
- Primary source code: app/, components/, lib/
- Configuration: Only read when explicitly needed
- Documentation: Only read if task requires it
- Tests: Only read if task involves testing

## Task Execution
- Analyze the task first to identify relevant files
- Read only those specific files
- Make changes efficiently
- Avoid unnecessary file operations
