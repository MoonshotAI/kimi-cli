/**
 * Markdown rendering component tests.
 *
 * Tests the MarkdownRenderer, CodeBlock, InlineStyles, Table,
 * committed boundary algorithm, and ThinkingBlock component.
 */

import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { Text } from 'ink';

import MarkdownRenderer from '../../src/components/markdown/MarkdownRenderer.js';
import CodeBlock from '../../src/components/markdown/CodeBlock.js';
import InlineStyles from '../../src/components/markdown/InlineStyles.js';
import Table from '../../src/components/markdown/Table.js';
import { committedBoundary } from '../../src/components/markdown/committed-boundary.js';
import ThinkingBlock from '../../src/components/message/ThinkingBlock.js';
import { lexer, type Tokens } from 'marked';

// ── Helper ──────────────────────────────────────────────────────────────

/** Render a component and return the last frame as a string. */
function renderText(element: React.JSX.Element): string {
  const { lastFrame, unmount } = render(element);
  const frame = lastFrame() ?? '';
  unmount();
  return frame;
}

// ── MarkdownRenderer tests ──────────────────────────────────────────────

describe('MarkdownRenderer', () => {
  describe('headings', () => {
    it('renders h1 with bold text and underline', () => {
      const frame = renderText(<MarkdownRenderer text="# Hello World" />);
      expect(frame).toContain('Hello World');
      expect(frame).toContain('='); // h1 underline
    });

    it('renders h2 with bold text', () => {
      const frame = renderText(<MarkdownRenderer text="## Section Title" />);
      expect(frame).toContain('Section Title');
    });

    it('renders h3 with bold text', () => {
      const frame = renderText(<MarkdownRenderer text="### Subsection" />);
      expect(frame).toContain('Subsection');
    });

    it('renders h6 with dimmed italic text', () => {
      const frame = renderText(<MarkdownRenderer text="###### Tiny heading" />);
      expect(frame).toContain('Tiny heading');
    });

    it('renders different heading levels differently', () => {
      const md = '# H1\n\n## H2\n\n### H3\n\n#### H4\n\n##### H5\n\n###### H6';
      const frame = renderText(<MarkdownRenderer text={md} />);
      expect(frame).toContain('H1');
      expect(frame).toContain('H2');
      expect(frame).toContain('H3');
      expect(frame).toContain('H4');
      expect(frame).toContain('H5');
      expect(frame).toContain('H6');
    });
  });

  describe('paragraphs', () => {
    it('renders plain text paragraphs', () => {
      const frame = renderText(<MarkdownRenderer text="Hello, this is a paragraph." />);
      expect(frame).toContain('Hello, this is a paragraph.');
    });

    it('renders multiple paragraphs', () => {
      const md = 'First paragraph.\n\nSecond paragraph.';
      const frame = renderText(<MarkdownRenderer text={md} />);
      expect(frame).toContain('First paragraph.');
      expect(frame).toContain('Second paragraph.');
    });
  });

  describe('inline styles', () => {
    it('renders bold text', () => {
      const frame = renderText(<MarkdownRenderer text="This is **bold** text." />);
      expect(frame).toContain('bold');
      expect(frame).toContain('This is');
      expect(frame).toContain('text.');
    });

    it('renders italic text', () => {
      const frame = renderText(<MarkdownRenderer text="This is *italic* text." />);
      expect(frame).toContain('italic');
    });

    it('renders inline code', () => {
      const frame = renderText(<MarkdownRenderer text="Use `console.log` for debugging." />);
      expect(frame).toContain('console.log');
    });

    it('renders strikethrough text', () => {
      const frame = renderText(<MarkdownRenderer text="This is ~~deleted~~ text." />);
      expect(frame).toContain('deleted');
    });

    it('renders links with URL', () => {
      const frame = renderText(<MarkdownRenderer text="Visit [Google](https://google.com) now." />);
      expect(frame).toContain('Google');
      expect(frame).toContain('https://google.com');
    });
  });

  describe('lists', () => {
    it('renders unordered list items with bullets', () => {
      const md = '- Item one\n- Item two\n- Item three';
      const frame = renderText(<MarkdownRenderer text={md} />);
      expect(frame).toContain('Item one');
      expect(frame).toContain('Item two');
      expect(frame).toContain('Item three');
      // Should use bullet character
      expect(frame).toContain('\u2022');
    });

    it('renders ordered list items with numbers', () => {
      const md = '1. First\n2. Second\n3. Third';
      const frame = renderText(<MarkdownRenderer text={md} />);
      expect(frame).toContain('First');
      expect(frame).toContain('Second');
      expect(frame).toContain('Third');
      expect(frame).toContain('1.');
      expect(frame).toContain('2.');
      expect(frame).toContain('3.');
    });

    it('renders nested lists', () => {
      const md = '- Parent\n  - Child\n  - Child 2\n- Parent 2';
      const frame = renderText(<MarkdownRenderer text={md} />);
      expect(frame).toContain('Parent');
      expect(frame).toContain('Child');
      expect(frame).toContain('Parent 2');
    });
  });

  describe('code blocks', () => {
    it('renders code blocks with content', () => {
      const md = '```javascript\nconst x = 1;\n```';
      const frame = renderText(<MarkdownRenderer text={md} />);
      expect(frame).toContain('const x = 1;');
    });

    it('renders code blocks with language label', () => {
      const md = '```python\nprint("hello")\n```';
      const frame = renderText(<MarkdownRenderer text={md} />);
      expect(frame).toContain('python');
      expect(frame).toContain('print');
    });

    it('renders code blocks without language', () => {
      const md = '```\nsome code\n```';
      const frame = renderText(<MarkdownRenderer text={md} />);
      expect(frame).toContain('some code');
    });
  });

  describe('blockquotes', () => {
    it('renders blockquotes with border', () => {
      const md = '> This is a quote';
      const frame = renderText(<MarkdownRenderer text={md} />);
      expect(frame).toContain('This is a quote');
      expect(frame).toContain('\u2502'); // vertical bar
    });
  });

  describe('horizontal rule', () => {
    it('renders horizontal rule', () => {
      const md = 'Before\n\n---\n\nAfter';
      const frame = renderText(<MarkdownRenderer text={md} />);
      expect(frame).toContain('\u2500'); // horizontal line character
    });
  });

  describe('tables', () => {
    it('renders table with aligned columns', () => {
      const md = '| Name | Age |\n|------|-----|\n| Alice | 30 |\n| Bob | 25 |';
      const frame = renderText(<MarkdownRenderer text={md} />);
      expect(frame).toContain('Name');
      expect(frame).toContain('Age');
      expect(frame).toContain('Alice');
      expect(frame).toContain('30');
      expect(frame).toContain('Bob');
      expect(frame).toContain('25');
    });
  });

  describe('empty input', () => {
    it('renders empty string without error', () => {
      const frame = renderText(<MarkdownRenderer text="" />);
      expect(frame).toBe('');
    });
  });

  describe('complex markdown', () => {
    it('renders a mix of elements', () => {
      const md = [
        '# Title',
        '',
        'A paragraph with **bold** and *italic*.',
        '',
        '- Item 1',
        '- Item 2',
        '',
        '```js',
        'const x = 42;',
        '```',
        '',
        '> A quote',
      ].join('\n');

      const frame = renderText(<MarkdownRenderer text={md} />);
      expect(frame).toContain('Title');
      expect(frame).toContain('bold');
      expect(frame).toContain('italic');
      expect(frame).toContain('Item 1');
      expect(frame).toContain('const x = 42;');
      expect(frame).toContain('A quote');
    });
  });
});

// ── CodeBlock tests ──────────────────────────────────────────────────────

describe('CodeBlock', () => {
  it('renders code content', () => {
    const frame = renderText(<CodeBlock code="const x = 1;" language="javascript" />);
    expect(frame).toContain('const x = 1;');
  });

  it('displays language label', () => {
    const frame = renderText(<CodeBlock code="print('hi')" language="python" />);
    expect(frame).toContain('python');
  });

  it('renders without language label when language is not provided', () => {
    const frame = renderText(<CodeBlock code="some text" />);
    expect(frame).toContain('some text');
  });

  it('handles syntax highlighting for supported languages', () => {
    // cli-highlight should produce ANSI codes for known languages.
    // We just verify it doesn't crash and renders the code.
    const frame = renderText(
      <CodeBlock code={'function hello() {\n  return "world";\n}'} language="javascript" />,
    );
    expect(frame).toContain('function');
    expect(frame).toContain('hello');
  });

  it('falls back to plain text for unsupported languages', () => {
    const frame = renderText(<CodeBlock code="some code" language="totally-unknown-lang" />);
    expect(frame).toContain('some code');
  });
});

// ── InlineStyles tests ──────────────────────────────────────────────────

describe('InlineStyles', () => {
  it('renders bold text', () => {
    const tokens = lexer('**bold text**');
    const paragraph = tokens[0] as Tokens.Paragraph;
    const frame = renderText(<InlineStyles tokens={paragraph.tokens} />);
    expect(frame).toContain('bold text');
  });

  it('renders italic text', () => {
    const tokens = lexer('*italic text*');
    const paragraph = tokens[0] as Tokens.Paragraph;
    const frame = renderText(<InlineStyles tokens={paragraph.tokens} />);
    expect(frame).toContain('italic text');
  });

  it('renders inline code', () => {
    const tokens = lexer('Use `code` here');
    const paragraph = tokens[0] as Tokens.Paragraph;
    const frame = renderText(<InlineStyles tokens={paragraph.tokens} />);
    expect(frame).toContain('code');
  });

  it('renders strikethrough', () => {
    const tokens = lexer('~~deleted~~');
    const paragraph = tokens[0] as Tokens.Paragraph;
    const frame = renderText(<InlineStyles tokens={paragraph.tokens} />);
    expect(frame).toContain('deleted');
  });

  it('renders link with URL', () => {
    const tokens = lexer('[Click here](https://example.com)');
    const paragraph = tokens[0] as Tokens.Paragraph;
    const frame = renderText(<InlineStyles tokens={paragraph.tokens} />);
    expect(frame).toContain('Click here');
    expect(frame).toContain('https://example.com');
  });
});

// ── Table tests ──────────────────────────────────────────────────────────

describe('Table', () => {
  it('renders table with headers and rows', () => {
    const tokens = lexer('| A | B |\n|---|---|\n| 1 | 2 |');
    const tableToken = tokens[0] as Tokens.Table;
    const frame = renderText(<Table token={tableToken} />);
    expect(frame).toContain('A');
    expect(frame).toContain('B');
    expect(frame).toContain('1');
    expect(frame).toContain('2');
  });

  it('renders table with pipe separators', () => {
    const tokens = lexer('| X | Y |\n|---|---|\n| a | b |');
    const tableToken = tokens[0] as Tokens.Table;
    const frame = renderText(<Table token={tableToken} />);
    expect(frame).toContain('|');
  });
});

// ── committedBoundary tests ──────────────────────────────────────────────

describe('committedBoundary', () => {
  it('returns empty for empty string', () => {
    const result = committedBoundary('');
    expect(result.committed).toBe('');
    expect(result.pending).toBe('');
  });

  it('returns full text as committed for complete Markdown with multiple blocks', () => {
    const text = '# Hello\n\nSome paragraph text.\n\nAnother paragraph.\n';
    const result = committedBoundary(text);
    // With 3 blocks (heading, paragraph, paragraph), the last one is pending.
    // committed should contain everything except the last block.
    expect(result.committed.length).toBeGreaterThan(0);
    expect(result.committed + result.pending).toBe(text);
  });

  it('treats unclosed code block as pending', () => {
    const text = 'Some text.\n\n```js\nconsole.log("hello")';
    const result = committedBoundary(text);
    // The unclosed code fence makes the parser produce only 1 block,
    // or puts the code fence as the last (potentially incomplete) block.
    // Either way, committed should not contain the incomplete code fence.
    expect(result.pending).toContain('console.log');
  });

  it('returns nothing committed for a single block', () => {
    const result = committedBoundary('Just a single paragraph.');
    expect(result.committed).toBe('');
    expect(result.pending).toBe('Just a single paragraph.');
  });

  it('returns nothing committed for only paragraph text', () => {
    const result = committedBoundary('Hello world');
    expect(result.committed).toBe('');
    expect(result.pending).toBe('Hello world');
  });

  it('correctly splits multiple complete blocks', () => {
    const text = '# Title\n\nParagraph one.\n\nParagraph two.\n';
    const result = committedBoundary(text);
    // Should commit all except the last block.
    expect(result.committed.length).toBeGreaterThan(0);
    expect(result.pending.length).toBeGreaterThan(0);
    expect(result.committed + result.pending).toBe(text);
  });

  it('handles complete code block followed by text', () => {
    const text = '```js\nconst x = 1;\n```\n\nSome text after.\n';
    const result = committedBoundary(text);
    expect(result.committed.length).toBeGreaterThan(0);
    expect(result.committed + result.pending).toBe(text);
  });
});

// ── ThinkingBlock tests ──────────────────────────────────────────────────

describe('ThinkingBlock', () => {
  it('renders 💭 prefix with empty text', () => {
    const frame = renderText(<ThinkingBlock text="" />);
    expect(frame).toContain('💭');
  });

  it('renders short text without truncation', () => {
    const text = 'Line 1\nLine 2\nLine 3';
    const frame = renderText(<ThinkingBlock text={text} />);
    expect(frame).toContain('Line 1');
    expect(frame).toContain('Line 2');
    expect(frame).toContain('Line 3');
    expect(frame).not.toContain('more lines');
  });

  it('truncates text longer than maxLines', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `Line ${String(i + 1)}`);
    const text = lines.join('\n');
    const frame = renderText(<ThinkingBlock text={text} maxLines={6} />);
    expect(frame).toContain('Line 1');
    expect(frame).toContain('Line 6');
    // Should NOT contain lines beyond maxLines
    expect(frame).not.toContain('Line 7');
    // Should show truncation indicator
    expect(frame).toContain('more lines');
  });

  it('uses default maxLines of 6', () => {
    const lines = Array.from({ length: 12 }, (_, i) => `Thought ${String(i + 1)}`);
    const text = lines.join('\n');
    const frame = renderText(<ThinkingBlock text={text} />);
    expect(frame).toContain('Thought 1');
    expect(frame).toContain('Thought 6');
    expect(frame).not.toContain('Thought 7');
    expect(frame).toContain('6 more lines');
  });

  it('does not truncate text with exactly maxLines', () => {
    const lines = Array.from({ length: 6 }, (_, i) => `Line ${String(i + 1)}`);
    const text = lines.join('\n');
    const frame = renderText(<ThinkingBlock text={text} maxLines={6} />);
    expect(frame).toContain('Line 1');
    expect(frame).toContain('Line 6');
    expect(frame).not.toContain('more lines');
  });
});
