import { loadTokens } from "../../../auth/oauth.ts";
import type { Config } from "../../../config.ts";
import type { CommandPanelConfig } from "../../../types.ts";
import { platform, release } from "node:os";

const ISSUE_URL = "https://github.com/MoonshotAI/kimi-cli/issues";

export async function handleFeedback(
	config: Config,
	args: string,
	sessionId: string,
	modelKey: string | undefined,
): Promise<string> {
	const content = args.trim();
	if (!content) {
		return `Usage: /feedback <your feedback text>\nOr submit at: ${ISSUE_URL}`;
	}

	// Try to find a provider with OAuth for posting feedback
	let apiKey: string | null = null;
	let baseUrl: string | null = null;

	for (const [, provider] of Object.entries(config.providers)) {
		if (provider.oauth) {
			const token = await loadTokens(provider.oauth);
			if (token) {
				apiKey = token.access_token;
				baseUrl = provider.base_url.replace(/\/+$/, "");
				break;
			}
		}
	}

	if (!apiKey || !baseUrl) {
		return `No authenticated platform found. Please submit feedback at: ${ISSUE_URL}`;
	}

	const payload = {
		session_id: sessionId,
		content,
		version: "2.0.0",
		os: `${platform()} ${release()}`,
		model: modelKey || null,
	};

	try {
		const res = await fetch(`${baseUrl}/feedback`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(payload),
		});
		if (res.ok) {
			return `Feedback submitted, thank you! Session ID: ${sessionId}`;
		} else {
			return `Failed to submit feedback (HTTP ${res.status}). Try: ${ISSUE_URL}`;
		}
	} catch (err) {
		return `Failed to submit feedback: ${err instanceof Error ? err.message : err}\nPlease submit at: ${ISSUE_URL}`;
	}
}

type Notify = (title: string, body: string) => void;

export function createFeedbackPanel(
	config: Config,
	sessionId: string,
	modelKey: string | undefined,
	notify: Notify,
): CommandPanelConfig {
	return {
		type: "input",
		title: "Submit Feedback",
		placeholder: "Describe your issue or suggestion...",
		onSubmit: (value: string) => {
			handleFeedback(config, value, sessionId, modelKey).catch(() => {
				notify("Feedback", `Please submit at: ${ISSUE_URL}`);
			});
		},
	};
}
