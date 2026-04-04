/**
 * /add-dir slash command handler.
 * Adds a directory to the workspace scope.
 * Corresponds to Python soul/slash.py add_dir command.
 */

import { resolve } from "node:path";
import { logger } from "../../../utils/logging.ts";
import type { Session } from "../../../session.ts";
import { saveSessionState } from "../../../session.ts";

export async function handleAddDir(
  session: Session,
  workDir: string,
  args: string,
): Promise<string | null> {
  const arg = args.trim();

  // No args: list currently added directories
  if (!arg) {
    const dirs = session.state.additional_dirs;
    if (!dirs.length) {
      logger.info("No additional directories. Usage: /add-dir <path>");
    } else {
      logger.info("Additional directories:");
      for (const d of dirs) {
        logger.info(`  - ${d}`);
      }
    }
    return null;
  }

  // Resolve the path
  const dirPath = resolve(arg.replace(/^~/, process.env.HOME ?? "~"));

  // Check existence
  const dirFile = Bun.file(dirPath);
  try {
    const stat = await Bun.$`test -d ${dirPath}`.quiet();
    if (stat.exitCode !== 0) {
      logger.info(`Not a directory: ${dirPath}`);
      return null;
    }
  } catch {
    logger.info(`Directory does not exist: ${dirPath}`);
    return null;
  }

  // Check if already added
  if (session.state.additional_dirs.includes(dirPath)) {
    logger.info(`Directory already in workspace: ${dirPath}`);
    return null;
  }

  // Check if within work dir
  if (dirPath.startsWith(workDir + "/") || dirPath === workDir) {
    logger.info(`Directory is already within the working directory: ${dirPath}`);
    return null;
  }

  // Check if within an already-added directory
  for (const existing of session.state.additional_dirs) {
    if (dirPath.startsWith(existing + "/") || dirPath === existing) {
      logger.info(`Directory is already within added directory ${existing}: ${dirPath}`);
      return null;
    }
  }

  // Validate readability
  let lsOutput = "";
  try {
    lsOutput = await Bun.$`ls -la ${dirPath}`.quiet().text();
  } catch (e) {
    logger.info(`Cannot read directory: ${dirPath}`);
    return null;
  }

  // Add the directory
  session.state.additional_dirs.push(dirPath);
  await saveSessionState(session.state, session.dir);

  logger.info(`Added directory to workspace: ${dirPath}`);

  // Return info string for injecting into context
  return (
    `The user has added an additional directory to the workspace: \`${dirPath}\`\n\n` +
    `Directory listing:\n\`\`\`\n${lsOutput.trim()}\n\`\`\`\n\n` +
    "You can now read, write, search, and glob files in this directory " +
    "as if it were part of the working directory."
  );
}
