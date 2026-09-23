/**
 * KimiCLI app orchestrator — corresponds to Python app.py
 * Creates and wires together all components.
 */

import { loadConfig, loadConfigFromString, type Config, type ConfigMeta } from "./config.ts";
import { createLLM, augmentProviderWithEnvVars, type LLM } from "./llm.ts";
import { OAuthManager, loadTokens, commonHeaders } from "./auth/oauth.ts";
import { Session } from "./session.ts";
import { HookEngine } from "./hooks/engine.ts";
import { Context } from "./soul/context.ts";
import { Runtime, Agent, loadAgent } from "./soul/agent.ts";
import { KimiSoul } from "./soul/kimisoul.ts";
import { logger } from "./utils/logging.ts";

// ── KimiCLI ─────────────────────────────────────────

export class KimiCLI {
	readonly soul: KimiSoul;
	readonly agent: Agent;
	readonly session: Session;
	readonly config: Config;
	readonly configMeta: ConfigMeta;
	readonly context: Context;

	private constructor(opts: {
		soul: KimiSoul;
		agent: Agent;
		session: Session;
		config: Config;
		configMeta: ConfigMeta;
		context: Context;
	}) {
		this.soul = opts.soul;
		this.agent = opts.agent;
		this.session = opts.session;
		this.config = opts.config;
		this.configMeta = opts.configMeta;
		this.context = opts.context;
	}

	// ── Factory ──────────────────────────────────────

	static async create(opts: {
		workDir?: string;
		additionalDirs?: string[];
		configFile?: string;
		configText?: string;
		modelName?: string;
		thinking?: boolean;
		yolo?: boolean;
		planMode?: boolean;
		resumed?: boolean;
		sessionId?: string;
		continueSession?: boolean;
		maxStepsPerTurn?: number;
		agentFile?: string;
		skillsDirs?: string[];
		mcpConfigs?: Record<string, unknown>[];
		deferMcpLoading?: boolean;
		// callbacks removed — now uses Wire architecture
	}): Promise<KimiCLI> {
		const workDir = opts.workDir ?? process.cwd();

		// 1. Load config
		const { config, meta: configMeta } = opts.configText
			? await loadConfigFromString(opts.configText)
			: await loadConfig(opts.configFile);

		// Override settings from CLI flags
		if (opts.maxStepsPerTurn) {
			config.loop_control.max_steps_per_turn = opts.maxStepsPerTurn;
		}
		if (opts.yolo) {
			config.default_yolo = true;
		}

		// Determine plan mode (only apply default for new sessions, not restored)
		let planMode = opts.planMode ?? false;
		if (!opts.resumed) {
			planMode = planMode || config.default_plan_mode;
		}

		// 2. Determine model
		const modelName = opts.modelName ?? config.default_model;
		let llm: LLM | null = null;

		if (modelName && config.models[modelName]) {
			const modelConfig = config.models[modelName]!;
			const providerName = modelConfig.provider;
			const providerConfig = config.providers[providerName];

			if (providerConfig) {
				// Resolve API key: if OAuth is configured, load the access token
				let apiKey = providerConfig.api_key;
				if (providerConfig.oauth) {
					const token = await loadTokens(providerConfig.oauth);
					if (token) {
						apiKey = token.access_token;
					}
				}

				// Build platform identification headers (matches Python _kimi_default_headers)
				const platformHeaders = await commonHeaders();
				const mergedCustomHeaders: Record<string, string> = {
					"User-Agent": `KimiCLI/2.0.0`,
					...platformHeaders,
					...(providerConfig.custom_headers ?? {}),
				};

				// Convert snake_case config to camelCase LLM interface
				const llmProvider = {
					type: providerConfig.type as any,
					baseUrl: providerConfig.base_url,
					apiKey,
					customHeaders: mergedCustomHeaders,
					env: providerConfig.env,
					oauth: providerConfig.oauth?.key ?? null,
				};
				const llmModel = {
					model: modelConfig.model,
					provider: modelConfig.provider,
					maxContextSize: modelConfig.max_context_size,
					capabilities: modelConfig.capabilities,
				};

				// Apply env var overrides
				augmentProviderWithEnvVars(llmProvider, llmModel);

				llm = createLLM(llmProvider, llmModel, {
					thinking: opts.thinking ?? config.default_thinking,
				});
			}
		}

		// Fallback: create LLM from environment variables directly
		// Supports: KIMI_BASE_URL, KIMI_API_KEY, KIMI_MODEL_NAME
		if (!llm) {
			const envBaseUrl = process.env.KIMI_BASE_URL;
			const envApiKey = process.env.KIMI_API_KEY;
			const envModel = process.env.KIMI_MODEL_NAME;

			if (envBaseUrl && envApiKey && envModel) {
				const envPlatformHeaders = await commonHeaders();
				const llmProvider = {
					type: "kimi" as const,
					baseUrl: envBaseUrl,
					apiKey: envApiKey,
					customHeaders: {
						"User-Agent": `KimiCLI/2.0.0`,
						...envPlatformHeaders,
					} as Record<string, string>,
				};
				const llmModel = {
					model: envModel,
					provider: "env",
					maxContextSize: parseInt(
						process.env.KIMI_MODEL_MAX_CONTEXT_SIZE ?? "131072",
						10,
					),
					capabilities: undefined as any,
				};

				llm = createLLM(llmProvider, llmModel, {
					thinking: opts.thinking ?? config.default_thinking,
				});

				if (llm) {
					logger.info(`LLM from env: ${envModel} @ ${envBaseUrl}`);
				}
			}
		}

		if (!llm) {
			logger.warn(
				`No LLM configured for model "${modelName}". ` +
					"Set up a model in ~/.kimi/config.toml",
			);
		}

		// 3. Create/restore session
		let session: Session;
		let resumed = opts.resumed ?? false;
		if (opts.sessionId) {
			const found = await Session.find(workDir, opts.sessionId);
			if (found) {
				session = found;
				resumed = true;
			} else {
				session = await Session.create(workDir, opts.sessionId);
			}
		} else if (opts.continueSession) {
			const continued = await Session.continue_(workDir);
			if (continued) {
				session = continued;
				resumed = true;
				logger.info(`Continuing session ${session.id}`);
			} else {
				session = await Session.create(workDir);
				logger.info("No previous session found, starting new session");
			}
		} else {
			session = await Session.create(workDir);
		}

		// Ensure session directory exists and set up disk logging
		await session.ensureDir();
		logger.setLogDir(session.dir);

		// Store additional dirs in session state
		if (opts.additionalDirs && opts.additionalDirs.length > 0) {
			session.state.additional_dirs = opts.additionalDirs.map((d) =>
				d.startsWith("/") ? d : `${workDir}/${d}`,
			);
		}

		// 4. Create hook engine
		const hookEngine = new HookEngine({
			hooks: config.hooks,
			cwd: workDir,
		});

		// 5. Create OAuth manager and initialize
		const oauth = new OAuthManager(config);
		await oauth.initialize();

		// 6. Create runtime
		const runtime = await Runtime.create({
			config,
			oauth,
			llm,
			session,
			hookEngine,
			skillsDirs: opts.skillsDirs,
		});

		// 7. Load agent
		const agent = await loadAgent({
			runtime,
			agentFile: opts.agentFile,
			mcpConfigs: opts.mcpConfigs,
			startMcpLoading: !(opts.deferMcpLoading ?? false),
		});

		// 8. Create/restore context
		const context = new Context(session.contextFile);
		await context.restore();

		// 9. Write system prompt if new context; otherwise use restored prompt
		if (!context.systemPrompt) {
			await context.writeSystemPrompt(agent.systemPrompt);
		} else {
			// On session continuation, use the system prompt from the restored context
			// to ensure consistency (the prompt may have changed between versions)
			(agent as any).systemPrompt = context.systemPrompt;
		}

		// 10. Create KimiSoul
		const soul = new KimiSoul({
			agent,
			context,
		});

		// Wire slash commands
		soul.wireSlashCommands();

		// Wire tool context (plan mode, ask user, etc.)
		soul.wireToolContext();

		// Activate plan mode if requested (for new sessions or --plan flag)
		if (planMode && !soul.planMode) {
			await soul.setPlanModeFromManual(true);
		} else if (planMode && soul.planMode) {
			// Already in plan mode from restored session, trigger activation reminder
			soul.schedulePlanActivationReminder();
		}

		return new KimiCLI({
			soul,
			agent,
			session,
			config,
			configMeta,
			context,
		});
	}

	// ── Run modes ────────────────────────────────────

	/**
	 * Run in interactive shell mode (React Ink TUI).
	 */
	async runShell(initialCommand?: string): Promise<boolean> {
		// This will be called from cli/index.ts with Ink rendering
		// The shell component will call soul.run() directly
		if (initialCommand) {
			await this.soul.run(initialCommand);
		}
		return true; // continue
	}

	/**
	 * Run in print mode (non-interactive).
	 */
	async runPrint(input: string): Promise<void> {
		await this.soul.run(input);
	}

	// ── Lifecycle ──────────────────────────────────

	async shutdown(): Promise<void> {
		this.soul.abort();
		await this.agent.toolset.cleanup();

		// Clean up empty sessions (no real messages exchanged)
		if (await this.session.isEmpty()) {
			await this.session.delete();
			logger.debug("Deleted empty session");
		} else {
			await this.session.saveState();
		}

		logger.info("KimiCLI shutdown complete");
	}
}
