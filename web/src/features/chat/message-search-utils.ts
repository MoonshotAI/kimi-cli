import type { LiveMessage } from "@/hooks/types";

/**
 * Extract searchable text content from a LiveMessage
 */
export function getSearchableText(message: LiveMessage): string {
  const parts: string[] = [];

  if (message.content) {
    parts.push(message.content);
  }
  if (message.thinking) {
    parts.push(message.thinking);
  }
  if (message.toolCall) {
    if (message.toolCall.title) {
      parts.push(message.toolCall.title);
    }
    if (typeof message.toolCall.input === "string") {
      parts.push(message.toolCall.input);
    } else if (message.toolCall.input) {
      parts.push(JSON.stringify(message.toolCall.input));
    }
    if (message.toolCall.output) {
      parts.push(message.toolCall.output);
    }
    if (message.toolCall.message) {
      parts.push(message.toolCall.message);
    }
  }
  if (message.codeSnippet?.code) {
    parts.push(message.codeSnippet.code);
  }

  return parts.join(" ");
}

/**
 * Search result with message index and match context
 */
export type SearchMatch = {
  /** Index of the message in the messages array */
  messageIndex: number;
  /** The message that matched */
  message: LiveMessage;
  /** Text snippet around the match for preview */
  snippet: string;
  /** Start position of the match in the snippet */
  matchStart: number;
  /** Length of the matched text */
  matchLength: number;
};

/**
 * Search messages for a query and return matches with context
 */
export function searchMessages(
  messages: LiveMessage[],
  query: string,
  contextChars = 50,
): SearchMatch[] {
  if (!query.trim()) {
    return [];
  }

  const lowerQuery = query.toLowerCase();
  const matches: SearchMatch[] = [];

  messages.forEach((message, index) => {
    const text = getSearchableText(message);
    const lowerText = text.toLowerCase();
    const matchPos = lowerText.indexOf(lowerQuery);

    if (matchPos !== -1) {
      // Extract snippet with context
      const start = Math.max(0, matchPos - contextChars);
      const end = Math.min(text.length, matchPos + query.length + contextChars);
      let snippet = text.slice(start, end);

      // Add ellipsis if truncated
      if (start > 0) snippet = "..." + snippet;
      if (end < text.length) snippet = snippet + "...";

      matches.push({
        messageIndex: index,
        message,
        snippet,
        matchStart: start > 0 ? matchPos - start + 3 : matchPos, // +3 for "..."
        matchLength: query.length,
      });
    }
  });

  return matches;
}
