/**
 * Hook runner — corresponds to Python hooks/runner.py
 * Executes individual hook commands with fail-open semantics.
 */

import { logger } from "../utils/logging.ts";

export interface HookResult {
	action: "allow" | "block";
	reason: string;
	stdout: string;
	stderr: string;
	exitCode: number;
	timedOut: boolean;
}

function defaultResult(overrides?: Partial<HookResult>): HookResult {
	return {
		action: "allow",
		reason: "",
		stdout: "",
		stderr: "",
		exitCode: 0,
		timedOut: false,
		...overrides,
	};
}

/**
 * Execute a single hook command. Fail-open: errors/timeouts -> allow.
 */
export async function runHook(
	command: string,
	inputData: Record<string, unknown>,
	opts?: { timeout?: number; cwd?: string },
): Promise<HookResult> {
	const timeout = opts?.timeout ?? 30;
	const cwd = opts?.cwd;

	try {
		const proc = Bun.spawn(["sh", "-c", command], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			cwd: cwd ?? undefined,
		});

		// Write input data to stdin
		proc.stdin.write(JSON.stringify(inputData));
		proc.stdin.end();

		// Wait with timeout
		const timeoutPromise = new Promise<"timeout">((resolve) => {
			const timer = setTimeout(() => resolve("timeout"), timeout * 1000);
			if (typeof timer === "object" && "unref" in timer) {
				(timer as NodeJS.Timeout).unref();
			}
		});

		const exitPromise = proc.exited.then(() => "done" as const);
		const race = await Promise.race([exitPromise, timeoutPromise]);

		if (race === "timeout") {
			proc.kill();
			await proc.exited;
			logger.warn(`Hook timed out after ${timeout}s: ${command}`);
			return defaultResult({ timedOut: true });
		}

		const stdout = await new Response(proc.stdout).text();
		const stderr = await new Response(proc.stderr).text();
		const exitCode = proc.exitCode ?? 0;

		// Exit 2 = block
		if (exitCode === 2) {
			return {
				action: "block",
				reason: stderr.trim(),
				stdout,
				stderr,
				exitCode: 2,
				timedOut: false,
			};
		}

		// Exit 0 + JSON stdout = structured decision
		if (exitCode === 0 && stdout.trim()) {
			try {
				const raw = JSON.parse(stdout);
				if (raw && typeof raw === "object") {
					const hookOutput = raw.hookSpecificOutput ?? {};
					if (hookOutput.permissionDecision === "deny") {
						return {
							action: "block",
							reason: String(hookOutput.permissionDecisionReason ?? ""),
							stdout,
							stderr,
							exitCode: 0,
							timedOut: false,
						};
					}
				}
			} catch {
				// JSON parse error — ignore
			}
		}

		return defaultResult({ stdout, stderr, exitCode });
	} catch (err) {
		const errMsg = err instanceof Error ? err.message : String(err);
		logger.warn(`Hook failed: ${command}: ${errMsg}`);
		return defaultResult({ stderr: errMsg });
	}
}
