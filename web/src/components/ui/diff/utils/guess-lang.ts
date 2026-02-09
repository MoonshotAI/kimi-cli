const extToLang: Record<string, string> = {
  // JavaScript/TypeScript
  js: "javascript",
  jsx: "jsx",
  ts: "typescript",
  tsx: "tsx",
  mjs: "javascript",
  cjs: "javascript",

  // Web
  html: "markup",
  htm: "markup",
  xml: "markup",
  svg: "markup",
  css: "css",
  scss: "scss",
  sass: "sass",
  less: "less",
  stylus: "stylus",

  // Python
  py: "python",
  pyw: "python",
  pyi: "python",

  // Java/JVM
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  scala: "scala",
  groovy: "groovy",

  // C/C++
  c: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  h: "cpp",
  hpp: "cpp",
  hh: "cpp",
  hxx: "cpp",

  // C#/.NET
  cs: "csharp",
  vb: "vbnet",
  fs: "fsharp",

  // Rust
  rs: "rust",

  // Go
  go: "go",

  // Ruby
  rb: "ruby",
  rake: "ruby",

  // PHP
  php: "php",
  phtml: "php",

  // Shell
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "bash",

  // Data formats
  json: "json",
  json5: "json5",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  ini: "ini",
  csv: "csv",

  // Markdown/Docs
  md: "markdown",
  markdown: "markdown",
  tex: "latex",

  // Swift/Objective-C
  swift: "swift",
  m: "objectivec",
  mm: "objectivec",

  // SQL
  sql: "sql",

  // Other languages
  r: "r",
  lua: "lua",
  perl: "perl",
  pl: "perl",
  dart: "dart",
  elm: "elm",
  ex: "elixir",
  exs: "elixir",
  erl: "erlang",
  clj: "clojure",
  cljs: "clojure",
  lisp: "lisp",
  hs: "haskell",
  ml: "ocaml",

  // Config files
  dockerfile: "docker",
  gitignore: "ignore",

  // Other
  graphql: "graphql",
  proto: "protobuf",
  wasm: "wasm",
  vim: "vim",
  zig: "zig",
  mermaid: "mermaid",
};

export const guessLang = (filename?: string): string => {
  const ext = filename?.split(".").pop()?.toLowerCase() ?? "";
  return extToLang[ext] ?? "tsx";
};
