/**
 * /init slash command handler.
 * Analyzes the codebase and generates an AGENTS.md file.
 * Corresponds to Python soul/slash.py init command.
 */

/**
 * Handle /init command — trigger codebase analysis and AGENTS.md generation.
 * In the Python version this creates a temporary context, runs a prompt through the LLM,
 * then reloads the generated AGENTS.md. For now we provide a simplified version.
 */
export async function handleInit(workDir: string): Promise<string> {
  const agentsMdPath = `${workDir}/AGENTS.md`;

  // Check if AGENTS.md already exists
  const existing = Bun.file(agentsMdPath);
  if (await existing.exists()) {
    return `AGENTS.md already exists at ${agentsMdPath}\nTo regenerate, delete it first and run /init again.`;
  }

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
    return `Generated AGENTS.md at ${agentsMdPath}\nEdit it to describe your project for better AI assistance.`;
  } catch (err) {
    return `Failed to generate AGENTS.md: ${err instanceof Error ? err.message : err}`;
  }
}
