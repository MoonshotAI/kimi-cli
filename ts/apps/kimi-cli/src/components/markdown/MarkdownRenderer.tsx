/**
 * MarkdownRenderer component -- renders Markdown text as styled Ink elements.
 *
 * Uses marked's lexer to parse Markdown into an AST, then walks the token
 * tree and renders each block/inline element using Ink `<Text>` and `<Box>`
 * components with appropriate styling.
 *
 * Supports: headings (h1-h6), paragraphs, lists (ordered/unordered/nested),
 * code blocks (with syntax highlighting via CodeBlock), inline code, tables,
 * links, bold, italic, strikethrough, horizontal rules, blockquotes.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { lexer, type Token, type Tokens } from 'marked';

import CodeBlock from './CodeBlock.js';
import Table from './Table.js';
import { renderInlineTokens } from './InlineStyles.js';

export interface MarkdownRendererProps {
  /** The Markdown text to render. */
  readonly text: string;
}

export default function MarkdownRenderer({
  text,
}: MarkdownRendererProps): React.JSX.Element {
  if (text.length === 0) {
    return <Text>{''}</Text>;
  }

  let tokens: Token[];
  try {
    tokens = lexer(text);
  } catch {
    // If parsing fails, render as plain text.
    return <Text>{text}</Text>;
  }

  return (
    <Box flexDirection="column">
      {tokens.map((token, index) => (
        <BlockToken key={index} token={token} />
      ))}
    </Box>
  );
}

// ── Block-level token renderer ────────────────────────────────────────

interface BlockTokenProps {
  readonly token: Token;
}

function BlockToken({ token }: BlockTokenProps): React.JSX.Element | null {
  switch (token.type) {
    case 'heading':
      return <Heading token={token as Tokens.Heading} />;
    case 'paragraph':
      return <Paragraph token={token as Tokens.Paragraph} />;
    case 'code':
      return <CodeBlock language={(token as Tokens.Code).lang} code={(token as Tokens.Code).text} />;
    case 'list':
      return <List token={token as Tokens.List} depth={0} />;
    case 'table':
      return <Table token={token as Tokens.Table} />;
    case 'blockquote':
      return <Blockquote token={token as Tokens.Blockquote} />;
    case 'hr':
      return <HorizontalRule />;
    case 'html':
      return <Text>{(token as Tokens.HTML).text}</Text>;
    case 'space':
      return null;
    default:
      // For unrecognised block tokens, try to render raw text.
      return <Text>{(token as { raw?: string }).raw ?? ''}</Text>;
  }
}

// ── Heading ───────────────────────────────────────────────────────────

function Heading({ token }: { readonly token: Tokens.Heading }): React.JSX.Element {
  const { depth, tokens: inlineTokens } = token;

  switch (depth) {
    case 1:
      return (
        <Box flexDirection="column">
          <Text bold color="white">
            {inlineTokens ? renderInlineTokens(inlineTokens) : token.text}
          </Text>
          <Text bold color="white">
            {'='.repeat(Math.max(1, token.text.length))}
          </Text>
        </Box>
      );
    case 2:
      return (
        <Text bold underline color="white">
          {inlineTokens ? renderInlineTokens(inlineTokens) : token.text}
        </Text>
      );
    case 3:
      return (
        <Text bold>
          {inlineTokens ? renderInlineTokens(inlineTokens) : token.text}
        </Text>
      );
    case 4:
      return (
        <Text bold>
          {inlineTokens ? renderInlineTokens(inlineTokens) : token.text}
        </Text>
      );
    case 5:
      return (
        <Text bold>
          {inlineTokens ? renderInlineTokens(inlineTokens) : token.text}
        </Text>
      );
    case 6:
      return (
        <Text dimColor italic>
          {inlineTokens ? renderInlineTokens(inlineTokens) : token.text}
        </Text>
      );
    default:
      return (
        <Text bold>
          {inlineTokens ? renderInlineTokens(inlineTokens) : token.text}
        </Text>
      );
  }
}

// ── Paragraph ─────────────────────────────────────────────────────────

function Paragraph({
  token,
}: {
  readonly token: Tokens.Paragraph;
}): React.JSX.Element {
  return <Text>{token.tokens ? renderInlineTokens(token.tokens) : token.text}</Text>;
}

// ── List ──────────────────────────────────────────────────────────────

interface ListProps {
  readonly token: Tokens.List;
  readonly depth: number;
}

function List({ token, depth }: ListProps): React.JSX.Element {
  const { ordered, start, items } = token;
  const startNum = typeof start === 'number' ? start : 1;
  const indent = '  '.repeat(depth);

  return (
    <Box flexDirection="column">
      {items.map((item: Tokens.ListItem, index: number) => {
        const bullet = ordered ? `${String(startNum + index)}. ` : '\u2022 ';
        const { inlineNodes, nestedLists } = splitListItemContent(item, depth);

        return (
          <Box key={index} flexDirection="column">
            <Text>
              <Text>{indent}</Text>
              <Text>{bullet}</Text>
              <Text>{inlineNodes}</Text>
            </Text>
            {nestedLists}
          </Box>
        );
      })}
    </Box>
  );
}

/**
 * Split a list item's tokens into inline content (text, bold, etc.)
 * and nested block content (sub-lists). This is necessary because
 * `<Box>` components (used by nested lists) cannot appear inside `<Text>`.
 */
function splitListItemContent(
  item: Tokens.ListItem,
  depth: number,
): { inlineNodes: React.ReactNode[]; nestedLists: React.ReactNode[] } {
  const inlineNodes: React.ReactNode[] = [];
  const nestedLists: React.ReactNode[] = [];

  if (!item.tokens) {
    return { inlineNodes: [<Text key={0}>{item.text}</Text>], nestedLists: [] };
  }

  for (let i = 0; i < item.tokens.length; i++) {
    const token = item.tokens[i]!;
    if (token.type === 'list') {
      // Nested list -- render as a separate block element.
      nestedLists.push(
        <List key={`nested-${i}`} token={token as Tokens.List} depth={depth + 1} />,
      );
    } else if (token.type === 'text') {
      const t = token as Tokens.Text;
      if (t.tokens && t.tokens.length > 0) {
        inlineNodes.push(...renderInlineTokens(t.tokens).map((n, j) =>
          React.isValidElement(n) ? React.cloneElement(n, { key: `${i}-${j}` }) : n,
        ));
      } else {
        inlineNodes.push(<Text key={i}>{t.text}</Text>);
      }
    } else if (token.type === 'paragraph') {
      const t = token as Tokens.Paragraph;
      if (t.tokens) {
        inlineNodes.push(...renderInlineTokens(t.tokens).map((n, j) =>
          React.isValidElement(n) ? React.cloneElement(n, { key: `${i}-${j}` }) : n,
        ));
      } else {
        inlineNodes.push(<Text key={i}>{t.text}</Text>);
      }
    } else {
      // Other block elements in list items -- render as separate blocks.
      nestedLists.push(<BlockToken key={`block-${i}`} token={token} />);
    }
  }

  return { inlineNodes, nestedLists };
}

// ── Blockquote ────────────────────────────────────────────────────────

function Blockquote({
  token,
}: {
  readonly token: Tokens.Blockquote;
}): React.JSX.Element {
  return (
    <Box>
      <Text color="gray">{'\u2502 '}</Text>
      <Box flexDirection="column">
        {token.tokens
          ? token.tokens.map((t, i) => (
              <Text key={i} color="gray">
                {t.type === 'paragraph'
                  ? renderInlineTokens((t as Tokens.Paragraph).tokens ?? [])
                  : (t as { raw?: string }).raw ?? ''}
              </Text>
            ))
          : <Text color="gray">{token.text}</Text>}
      </Box>
    </Box>
  );
}

// ── Horizontal Rule ───────────────────────────────────────────────────

function HorizontalRule(): React.JSX.Element {
  return <Text dimColor>{'\u2500'.repeat(40)}</Text>;
}
