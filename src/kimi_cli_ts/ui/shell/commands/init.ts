/**
 * /init slash command handler.
 * Analyzes the codebase and generates an AGENTS.md file.
 * Corresponds to Python soul/slash.py init command.
 */

import { logger } from "../../../utils/logging.ts";

/**
 * Handle /init command — trigger codebase analysis and AGENTS.md generation.
 * In the Python version this creates a temporary context, runs a prompt through the LLM,
 * then reloads the generated AGENTS.md. For now we provide a simplified version.
 */
export async function handleInit(workDir: string): Promise<string | null> {
  const agentsMdPath = `${workDir}/AGENTS.md`;

  // Check if AGENTS.md already exists
  const existing = Bun.file(agentsMdPath);
  if (await existing.exists()) {
    logger.info(`AGENTS.md already exists at ${agentsMdPath}`);
    logger.info("To regenerate, delete it first and run /init again.");
    return null;
  }

  logger.info("Analyzing codebase to generate AGENTS.md...");
  logger.info("Note: Full /init requires an LLM call. Generating a basic template.");

  // Generate a basic template
  let lsOutput = "";
  try {
    lsOutput = await Bun.$`ls -la ${workDir}`.quiet().text();
  } catch {
    lsOutput = "(unable to list directory)";
  }

  const template = [
    "# AGENTS.md",
    "",
    "## Project Overview",
    "",
    "<!-- Describe your project here -->",
    "",
    "## Directory Structure",
    "",
    "```",
    lsOutput.trim(),
    "```",
    "",
    "## Conventions",
    "",
    "<!-- Describe coding conventions, testing practices, etc. -->",
    "",
  ].join("\n");

  try {
    await Bun.write(agentsMdPath, template);
    logger.info(`Generated AGENTS.md at ${agentsMdPath}`);
    logger.info("Edit it to describe your project for better AI assistance.");
    return template;
  } catch (err) {
    logger.info(`Failed to generate AGENTS.md: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}
