/**
 * /init slash command handler.
 * Analyzes the codebase and generates an AGENTS.md file.
 * Corresponds to Python soul/slash.py init command.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { Context } from "../../../soul/context.ts";
import { loadAgentsMd } from "../../../soul/agent.ts";
import { system } from "../../../soul/message.ts";
import { logger } from "../../../utils/logging.ts";
import type { Agent } from "../../../soul/agent.ts";
import type { Message } from "../../../types.ts";

/**
 * The INIT prompt — matches Python's `prompts/init.md`.
 * Instructs the LLM to explore the codebase and generate AGENTS.md.
 */
const INIT_PROMPT = `You are a software engineering expert with many years of programming experience. Please explore the current project directory to understand the project's architecture and main details.

Task requirements:
1. Analyze the project structure and identify key configuration files (such as pyproject.toml, package.json, Cargo.toml, etc.).
2. Understand the project's technology stack, build process and runtime architecture.
3. Identify how the code is organized and main module divisions.
4. Discover project-specific development conventions, testing strategies, and deployment processes.

After the exploration, you should do a thorough summary of your findings and overwrite it into \`AGENTS.md\` file in the project root. You need to refer to what is already in the file when you do so.

For your information, \`AGENTS.md\` is a file intended to be read by AI coding agents. Expect the reader of this file know nothing about the project.

You should compose this file according to the actual project content. Do not make any assumptions or generalizations. Ensure the information is accurate and useful. You must use the natural language that is mainly used in the project's comments and documentation.

Popular sections that people usually write in \`AGENTS.md\` are:

- Project overview
- Build and test commands
- Code style guidelines
- Testing instructions
- Security considerations`;

/**
 * Handle /init command — trigger codebase analysis and AGENTS.md generation.
 *
 * Matches Python behavior:
 * 1. Create a temporary context
 * 2. Create a temporary KimiSoul with the same agent but temp context
 * 3. Run the INIT prompt through the temp soul (LLM analyzes codebase & writes AGENTS.md)
 * 4. Load the generated AGENTS.md
 * 5. Inject a system message into the real context
 */
export async function handleInit(
	agent: Agent,
	context: Context,
): Promise<void> {
	const workDir = agent.runtime.session.workDir;

	// Create a temporary directory for the temp context
	const tempDir = await mkdtemp(join(tmpdir(), "kimi-init-"));

	try {
		// Create a temporary context backed by a temp file
		const tmpContext = new Context(join(tempDir, "context.jsonl"));

		// Lazy import to avoid circular dependency (kimisoul → init → kimisoul)
		// Matches Python's lazy `from kimi_cli.soul.kimisoul import KimiSoul` inside the function
		const { KimiSoul } = await import("../../../soul/kimisoul.ts");

		// Create a temporary KimiSoul with the same agent but temp context
		const tmpSoul = new KimiSoul({ agent, context: tmpContext });

		// Run the INIT prompt through the temp soul
		// This triggers the full agent loop: LLM will use tools to explore
		// the codebase and write AGENTS.md
		logger.info("Running /init: analyzing codebase...");
		await tmpSoul.run(INIT_PROMPT);
	} finally {
		// Clean up temp directory
		try {
			await rm(tempDir, { recursive: true, force: true });
		} catch {
			/* best-effort cleanup */
		}
	}

	// Load the (possibly newly generated) AGENTS.md
	const agentsMd = await loadAgentsMd(workDir);

	// Inject a system message into the real context
	const systemMessage = system(
		"The user just ran `/init` slash command. " +
			"The system has analyzed the codebase and generated an `AGENTS.md` file. " +
			(agentsMd
				? `Latest AGENTS.md file content:\n${agentsMd}`
				: "No AGENTS.md file was generated."),
	);
	const msg: Message = { role: "user", content: [systemMessage] };
	await context.appendMessage(msg);
}
