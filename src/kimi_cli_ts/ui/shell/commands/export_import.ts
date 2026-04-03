import type { Context } from "../../../soul/context.ts";
import type { Session } from "../../../session.ts";
import type { ContentPart } from "../../../types.ts";
import { join } from "node:path";
import { homedir } from "node:os";
import { logger } from "../../../utils/logging.ts";

export async function handleExport(context: Context, session: Session, args: string): Promise<void> {
  const history = context.history;
  if (!history.length) {
    logger.info("Nothing to export - context is empty.");
    return;
  }

  // Determine output path
  const outputDir = args.trim() || session.workDir;
  const filename = `kimi-export-${session.id.slice(0, 8)}.md`;
  const outputPath = join(outputDir, filename);

  // Build markdown
  const lines: string[] = [];
  lines.push(`# Kimi CLI Session Export`);
  lines.push(`Session: ${session.id}`);
  lines.push(`Exported: ${new Date().toISOString()}`);
  lines.push(`Messages: ${history.length}`);
  lines.push(`Tokens: ${context.tokenCountWithPending}`);
  lines.push("");

  for (let i = 0; i < history.length; i++) {
    const msg = history[i]!;
    lines.push(`## ${msg.role.toUpperCase()} (#${i + 1})`);
    lines.push("");
    if (typeof msg.content === "string") {
      lines.push(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content as ContentPart[]) {
        if (part.type === "text") {
          lines.push(part.text);
        } else if (part.type === "tool_use") {
          lines.push(`**Tool Call: ${part.name}**`);
          lines.push("```json");
          lines.push(JSON.stringify(part.input, null, 2));
          lines.push("```");
        } else if (part.type === "tool_result") {
          lines.push(`**Tool Result** (${part.isError ? "error" : "success"})`);
          lines.push("```");
          lines.push(part.content);
          lines.push("```");
        }
      }
    }
    lines.push("");
  }

  try {
    await Bun.write(outputPath, lines.join("\n"));
    // Shorten home dir for display
    const display = outputPath.replace(homedir(), "~");
    logger.info(`Exported ${history.length} messages to ${display}`);
    logger.info("Note: The exported file may contain sensitive information.");
  } catch (err) {
    logger.info(`Failed to export: ${err instanceof Error ? err.message : err}`);
  }
}

export async function handleImport(context: Context, session: Session, args: string): Promise<void> {
  const target = args.trim();
  if (!target) {
    logger.info("Usage: /import <file_path or session_id>");
    return;
  }

  // Check if it's a file path
  const file = Bun.file(target);
  if (await file.exists()) {
    try {
      const content = await file.text();
      // Append as a user message with import marker
      await context.appendMessage({
        role: "user",
        content: `[Imported from ${target}]\n\n${content}`,
      });
      logger.info(`Imported ${content.length} chars from ${target}`);
    } catch (err) {
      logger.info(`Failed to import: ${err instanceof Error ? err.message : err}`);
    }
    return;
  }

  // Try as session ID
  const { Session: SessionClass } = await import("../../../session.ts");
  const otherSession = await SessionClass.find(session.workDir, target);
  if (!otherSession) {
    logger.info(`File not found and no session with ID: ${target}`);
    return;
  }

  // Read other session's context
  const contextFile = Bun.file(otherSession.contextFile);
  if (!(await contextFile.exists())) {
    logger.info("Target session has no context.");
    return;
  }

  const text = await contextFile.text();
  const messageCount = text.split("\n").filter(l => l.trim()).length;
  await context.appendMessage({
    role: "user",
    content: `[Imported context from session ${target}]\n\n${text}`,
  });
  logger.info(`Imported context from session ${target} (~${messageCount} entries)`);
}
