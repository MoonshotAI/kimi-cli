/**
 * CodeBlock component -- renders a fenced code block with syntax highlighting.
 *
 * Uses `cli-highlight` to produce ANSI-colored output, then wraps it in
 * Ink `<Text>`. The ANSI escape codes from cli-highlight are preserved
 * and rendered correctly by Ink.
 *
 * Displays a language label above the code when a language is specified.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { highlight, supportsLanguage } from 'cli-highlight';

export interface CodeBlockProps {
  /** Programming language for syntax highlighting. */
  readonly language?: string | undefined;
  /** The code content (without fences). */
  readonly code: string;
}

export default function CodeBlock({ language, code }: CodeBlockProps): React.JSX.Element {
  const trimmedCode = code.replace(/\n$/, '');
  let highlighted: string;

  try {
    if (language && supportsLanguage(language)) {
      highlighted = highlight(trimmedCode, {
        language,
        ignoreIllegals: true,
      });
    } else {
      // No language or unsupported language -- render plain.
      highlighted = trimmedCode;
    }
  } catch {
    // If highlighting fails, fall back to plain text.
    highlighted = trimmedCode;
  }

  return (
    <Box flexDirection="column" marginLeft={2}>
      {language ? (
        <Text dimColor>{`  ${language}`}</Text>
      ) : null}
      <Text>{highlighted}</Text>
    </Box>
  );
}
