# ArchiveSearch

Search the session's archived conversation history for relevant context.

When the conversation grows beyond the API's payload limit, older messages are
summarized and stored in a local archive. This tool lets you retrieve that
context when you need it.

Use this tool when:
- The user references something from earlier in the session
- You need to recall a decision, file path, or technical detail from past turns
- You suspect relevant context was archived due to size limits

The archive contains semantic embeddings, so searches match by meaning rather
than exact keywords.
