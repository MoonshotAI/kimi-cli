/**
 * Glob → RegExp compiler for permission rule arg patterns (v2 §9-E.3.1 / §9-E.5).
 *
 * Supported syntax (aligned with minimatch / cc bash permission DSL):
 *   *          matches any run of characters within a single path segment (no `/`)
 *   **         matches any run of characters including `/` (cross-segment)
 *   ?          matches a single non-`/` character
 *   [abc]      character class
 *   {a,b,c}    brace alternation
 *
 * Negation (`!` prefix) is handled one level up in `matches-rule.ts`; this
 * compiler assumes the raw positive glob and returns an anchored RegExp.
 */

/**
 * Convert a positive glob pattern to an anchored regular expression. The
 * returned RegExp matches the entire input string (anchored `^…$`).
 *
 * Pure function. Deterministic. No caching here — callers that want
 * caching should memoize at the rule level.
 */
export function globToRegex(glob: string): RegExp {
  let i = 0;
  let out = '^';
  const len = glob.length;

  while (i < len) {
    const ch: string = glob[i] ?? '';

    if (ch === '*') {
      if (glob[i + 1] === '*') {
        // `**` → match anything including `/`
        out += '.*';
        i += 2;
        // Consume an optional trailing `/` after `**` so `src/**/foo`
        // and `src/**foo` behave symmetrically with cc-style globs.
        if (glob[i] === '/') {
          i += 1;
        }
      } else {
        // `*` → match any run within a segment
        out += '[^/]*';
        i += 1;
      }
      continue;
    }

    if (ch === '?') {
      out += '[^/]';
      i += 1;
      continue;
    }

    if (ch === '[') {
      // Character class — copy verbatim until the matching `]`.
      const end = glob.indexOf(']', i + 1);
      if (end === -1) {
        // Unterminated class: treat `[` as literal.
        out += '\\[';
        i += 1;
        continue;
      }
      out += glob.slice(i, end + 1);
      i = end + 1;
      continue;
    }

    if (ch === '{') {
      // Brace alternation `{a,b,c}` → `(a|b|c)`. Nesting is not
      // supported (same as minimatch default).
      const end = glob.indexOf('}', i + 1);
      if (end === -1) {
        out += '\\{';
        i += 1;
        continue;
      }
      const inner = glob.slice(i + 1, end);
      const alts = inner.split(',').map((alt) => globToRegex(alt).source.slice(1, -1));
      out += `(?:${alts.join('|')})`;
      i = end + 1;
      continue;
    }

    // Escape regex specials.
    if (/[.+^$()|\\]/.test(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
    i += 1;
  }

  out += '$';
  return new RegExp(out);
}
