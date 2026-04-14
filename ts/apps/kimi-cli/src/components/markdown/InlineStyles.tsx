/**
 * InlineStyles component -- renders inline Markdown tokens.
 *
 * Handles: text, strong (bold), em (italic), codespan (inline code),
 * del (strikethrough), link, and nested inline tokens.
 *
 * Uses Ink's `<Text>` props (bold, italic, etc.) rather than chalk,
 * since Ink manages its own rendering pipeline.
 */

import React from 'react';
import { Text } from 'ink';
import type { Token, Tokens } from 'marked';

export interface InlineStylesProps {
  readonly tokens: Token[];
}

/**
 * Render a list of inline tokens as styled Ink `<Text>` elements.
 */
export default function InlineStyles({ tokens }: InlineStylesProps): React.JSX.Element {
  return <Text>{renderInlineTokens(tokens)}</Text>;
}

/**
 * Recursively render inline tokens into React elements.
 */
export function renderInlineTokens(tokens: Token[]): React.ReactNode[] {
  return tokens.map((token, index) => renderInlineToken(token, index));
}

function renderInlineToken(token: Token, key: number): React.ReactNode {
  switch (token.type) {
    case 'text': {
      const t = token as Tokens.Text;
      // Text tokens may have nested tokens (e.g., from line breaks in paragraphs).
      if (t.tokens && t.tokens.length > 0) {
        return <Text key={key}>{renderInlineTokens(t.tokens)}</Text>;
      }
      return <Text key={key}>{t.text}</Text>;
    }

    case 'strong': {
      const t = token as Tokens.Strong;
      return (
        <Text key={key} bold>
          {t.tokens ? renderInlineTokens(t.tokens) : t.text}
        </Text>
      );
    }

    case 'em': {
      const t = token as Tokens.Em;
      return (
        <Text key={key} italic>
          {t.tokens ? renderInlineTokens(t.tokens) : t.text}
        </Text>
      );
    }

    case 'codespan': {
      const t = token as Tokens.Codespan;
      return (
        <Text key={key} color="cyan" bold>
          {t.text}
        </Text>
      );
    }

    case 'del': {
      const t = token as Tokens.Del;
      return (
        <Text key={key} strikethrough>
          {t.tokens ? renderInlineTokens(t.tokens) : t.text}
        </Text>
      );
    }

    case 'link': {
      const t = token as Tokens.Link;
      const linkText = t.tokens ? renderInlineTokens(t.tokens) : t.text;
      return (
        <Text key={key}>
          <Text underline color="cyan">
            {linkText}
          </Text>
          <Text dimColor>{` (${t.href})`}</Text>
        </Text>
      );
    }

    case 'image': {
      const t = token as Tokens.Image;
      return (
        <Text key={key}>
          <Text dimColor>[image: </Text>
          <Text underline color="cyan">
            {t.text || t.href}
          </Text>
          <Text dimColor>]</Text>
        </Text>
      );
    }

    case 'br': {
      return <Text key={key}>{'\n'}</Text>;
    }

    case 'escape': {
      const t = token as Tokens.Escape;
      return <Text key={key}>{t.text}</Text>;
    }

    case 'html': {
      // Render HTML inline tokens as plain text.
      const t = token as Tokens.HTML;
      return <Text key={key}>{t.text}</Text>;
    }

    default: {
      // For unknown inline tokens, try to render their text content.
      const t = token as { text?: string; raw?: string };
      return <Text key={key}>{t.text ?? t.raw ?? ''}</Text>;
    }
  }
}
