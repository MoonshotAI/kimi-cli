/**
 * ACP server — corresponds to Python acp/server.py
 * Manages ACP sessions, model switching, authentication, and prompt routing.
 */

import type { ACPClient } from "./kaos.ts";
import { ACPKaos } from "./kaos.ts";
import { acpMcpServersToMcpConfig } from "./mcp.ts";
import { ACPSession } from "./session.ts";
import { replaceTools } from "./tools.ts";
import type {
	ACPContentBlock,
	MCPServer,
	ClientCapabilities,
	AgentCapabilities,
	AuthMethod,
	Implementation,
	InitializeResponse,
	NewSessionResponse,
	ResumeSessionResponse,
	ListSessionsResponse,
	SessionInfo,
	SessionMode,
	SessionModeState,
	SessionModelState,
	ModelInfo,
	PromptResponse,
	AuthenticateResponse,
	AvailableCommand,
	AvailableCommandsUpdate,
} from "./types.ts";
import { ACPRequestError } from "./types.ts";
import { negotiateVersion } from "./version.ts";
import type { ACPVersionSpec } from "./version.ts";
import { KimiCLI } from "../app.ts";
import { KIMI_CODE_OAUTH_KEY, loadTokens } from "../auth/oauth.ts";
import { loadConfig, saveConfig } from "../config.ts";
import type { Config, LLMModel } from "../config.ts";
import { NAME, VERSION } from "../constant.ts";
import { createLLM, deriveModelCapabilities } from "../llm.ts";
import type { LLMProviderConfig, LLMModelConfig } from "../llm.ts";
import { Session } from "../session.ts";
import { KimiToolset } from "../soul/toolset.ts";
import { logger } from "../utils/logging.ts";

// ── _ModelIDConv ─────────────────────────────────────────

class _ModelIDConv {
	readonly modelKey: string;
	readonly thinking: boolean;

	constructor(modelKey: string, thinking: boolean) {
		this.modelKey = modelKey;
		this.thinking = thinking;
	}

	static fromAcpModelId(modelId: string): _ModelIDConv {
		if (modelId.endsWith(",thinking")) {
			return new _ModelIDConv(modelId.slice(0, -",thinking".length), true);
		}
		return new _ModelIDConv(modelId, false);
	}

	toAcpModelId(): string {
		if (this.thinking) {
			return `${this.modelKey},thinking`;
		}
		return this.modelKey;
	}

	equals(other: _ModelIDConv): boolean {
		return this.modelKey === other.modelKey && this.thinking === other.thinking;
	}
}

// ── _expandLlmModels ─────────────────────────────────────

function _expandLlmModels(models: Record<string, LLMModel>): ModelInfo[] {
	const expanded: ModelInfo[] = [];
	for (const [modelKey, model] of Object.entries(models)) {
		const modelConfig: LLMModelConfig = {
			model: model.model,
			provider: model.provider,
			maxContextSize: model.max_context_size,
			capabilities: model.capabilities,
		};
		const capabilities = deriveModelCapabilities(modelConfig);

		if (model.model.includes("thinking") || model.model.includes("reason")) {
			// always-thinking models
			expanded.push({
				model_id: new _ModelIDConv(modelKey, true).toAcpModelId(),
				name: model.model,
			});
		} else {
			expanded.push({
				model_id: modelKey,
				name: model.model,
			});
			if (capabilities.has("thinking")) {
				expanded.push({
					model_id: new _ModelIDConv(modelKey, true).toAcpModelId(),
					name: `${model.model} (thinking)`,
				});
			}
		}
	}
	return expanded;
}

// ── ACPServer ────────────────────────────────────────────

export class ACPServer {
	clientCapabilities: ClientCapabilities | null = null;
	conn: ACPClient | null = null;
	sessions = new Map<string, [ACPSession, _ModelIDConv]>();
	negotiatedVersion: ACPVersionSpec | null = null;
	private _authMethods: AuthMethod[] = [];

	onConnect(conn: ACPClient): void {
		logger.info("ACP client connected");
		this.conn = conn;
	}

	async initialize(opts: {
		protocolVersion: number;
		clientCapabilities?: ClientCapabilities | null;
		clientInfo?: Implementation | null;
	}): Promise<InitializeResponse> {
		this.negotiatedVersion = negotiateVersion(opts.protocolVersion);
		logger.info(
			`ACP server initialized with client protocol version: ${opts.protocolVersion}, ` +
				`negotiated version: ${JSON.stringify(this.negotiatedVersion)}, ` +
				`client capabilities: ${JSON.stringify(opts.clientCapabilities)}, ` +
				`client info: ${JSON.stringify(opts.clientInfo)}`,
		);
		this.clientCapabilities = opts.clientCapabilities ?? null;

		// get command and args of current process for terminal-auth
		const command = process.argv[1] ?? process.argv[0] ?? "kimi";
		const terminalArgs = ["login"];

		// Build and cache auth methods for reuse in AUTH_REQUIRED errors
		this._authMethods = [
			{
				id: "login",
				name: "Login with Kimi account",
				description:
					"Run `kimi login` command in the terminal, " +
					"then follow the instructions to finish login.",
				field_meta: {
					"terminal-auth": {
						command,
						args: terminalArgs,
						label: "Kimi Code Login",
						env: {},
						type: "terminal",
					},
				},
			},
		];

		return {
			protocol_version: this.negotiatedVersion.protocolVersion,
			agent_capabilities: {
				load_session: true,
				prompt_capabilities: {
					embedded_context: true,
					image: true,
					audio: false,
				},
				mcp_capabilities: { http: true, sse: false },
				session_capabilities: {
					list: {},
					resume: {},
				},
			},
			auth_methods: this._authMethods,
			agent_info: { name: NAME, version: VERSION },
		};
	}

	private static _checkTokenUsable(): string | null {
		const ref = { storage: "file" as const, key: KIMI_CODE_OAUTH_KEY };
		const token = loadTokens(ref);

		if (token === null || !(token as any)?.access_token) {
			return "no valid token found";
		}
		const t = token as any;
		if (t.expires_at && t.expires_at < Date.now() / 1000 && !t.refresh_token) {
			return "token expired and no refresh token available";
		}
		return null;
	}

	private _checkAuth(): void {
		const reason = ACPServer._checkTokenUsable();
		if (reason) {
			const authMethodsData: Record<string, unknown>[] = [];
			for (const m of this._authMethods) {
				if (m.field_meta && "terminal-auth" in m.field_meta) {
					const terminalAuth = m.field_meta["terminal-auth"] as Record<
						string,
						unknown
					>;
					authMethodsData.push({
						id: m.id,
						name: m.name,
						description: m.description,
						type: terminalAuth.type ?? "terminal",
						args: terminalAuth.args ?? [],
						env: terminalAuth.env ?? {},
					});
				}
			}
			logger.warn(`Authentication required, ${reason}`);
			throw ACPRequestError.authRequired({ authMethods: authMethodsData });
		}
	}

	async newSession(opts: {
		cwd: string;
		mcpServers?: MCPServer[] | null;
	}): Promise<NewSessionResponse> {
		logger.info(`Creating new session for working directory: ${opts.cwd}`);
		if (!this.conn) throw new Error("ACP client not connected");
		if (!this.clientCapabilities)
			throw new Error("ACP connection not initialized");

		this._checkAuth();

		const session = await Session.create(opts.cwd);
		const mcpConfig = acpMcpServersToMcpConfig(opts.mcpServers ?? []);

		const cli = await KimiCLI.create({
			workDir: opts.cwd,
			sessionId: session.id,
		});

		const config = cli.soul.runtime.config;
		const acpKaos = new ACPKaos(this.conn, session.id, this.clientCapabilities);
		const acpSession = new ACPSession(session.id, cli, this.conn, acpKaos);
		const modelIdConv = new _ModelIDConv(
			config.default_model,
			config.default_thinking,
		);
		this.sessions.set(session.id, [acpSession, modelIdConv]);

		if (cli.agent.toolset instanceof KimiToolset) {
			replaceTools(
				this.clientCapabilities,
				this.conn,
				session.id,
				cli.agent.toolset,
				cli.soul.runtime,
			);
		}

		// Send available commands in background
		const commands: AvailableCommand[] = cli.agent.slashCommands
			.list()
			.map((cmd) => ({
				name: cmd.name,
				description: cmd.description,
			}));

		// Fire and forget
		this.conn
			.sessionUpdate({
				sessionId: session.id,
				update: {
					session_update: "available_commands_update",
					available_commands: commands,
				} as AvailableCommandsUpdate,
			})
			.catch((e) => logger.warn(`Failed to send available commands: ${e}`));

		return {
			session_id: session.id,
			modes: _defaultModeState(),
			models: {
				available_models: _expandLlmModels(config.models),
				current_model_id: modelIdConv.toAcpModelId(),
			},
		};
	}

	private async _setupSession(opts: {
		cwd: string;
		sessionId: string;
		mcpServers?: MCPServer[] | null;
	}): Promise<[ACPSession, _ModelIDConv]> {
		if (!this.conn) throw new Error("ACP client not connected");
		if (!this.clientCapabilities)
			throw new Error("ACP connection not initialized");

		const session = await Session.find(opts.cwd, opts.sessionId);
		if (!session) {
			logger.error(
				`Session not found: ${opts.sessionId} for working directory: ${opts.cwd}`,
			);
			throw ACPRequestError.invalidParams({ session_id: "Session not found" });
		}

		const mcpConfig = acpMcpServersToMcpConfig(opts.mcpServers ?? []);

		const cli = await KimiCLI.create({
			workDir: opts.cwd,
			sessionId: opts.sessionId,
			resumed: true,
		});

		const config = cli.soul.runtime.config;
		const acpKaos = new ACPKaos(this.conn, session.id, this.clientCapabilities);
		const acpSession = new ACPSession(session.id, cli, this.conn, acpKaos);
		const modelIdConv = new _ModelIDConv(
			config.default_model,
			config.default_thinking,
		);
		this.sessions.set(session.id, [acpSession, modelIdConv]);

		if (cli.agent.toolset instanceof KimiToolset) {
			replaceTools(
				this.clientCapabilities,
				this.conn,
				session.id,
				cli.agent.toolset,
				cli.soul.runtime,
			);
		}

		return [acpSession, modelIdConv];
	}

	async loadSession(opts: {
		cwd: string;
		sessionId: string;
		mcpServers?: MCPServer[] | null;
	}): Promise<void> {
		logger.info(
			`Loading session: ${opts.sessionId} for working directory: ${opts.cwd}`,
		);

		if (this.sessions.has(opts.sessionId)) {
			logger.warn(`Session already loaded: ${opts.sessionId}`);
			return;
		}

		this._checkAuth();
		await this._setupSession(opts);
	}

	async resumeSession(opts: {
		cwd: string;
		sessionId: string;
		mcpServers?: MCPServer[] | null;
	}): Promise<ResumeSessionResponse> {
		logger.info(
			`Resuming session: ${opts.sessionId} for working directory: ${opts.cwd}`,
		);

		if (!this.sessions.has(opts.sessionId)) {
			await this._setupSession(opts);
		}

		const [acpSession, modelIdConv] = this.sessions.get(opts.sessionId)!;
		const config = acpSession.cli.soul.runtime.config;
		return {
			modes: _defaultModeState(),
			models: {
				available_models: _expandLlmModels(config.models),
				current_model_id: modelIdConv.toAcpModelId(),
			},
		};
	}

	async listSessions(opts: {
		cursor?: string | null;
		cwd?: string | null;
	}): Promise<ListSessionsResponse> {
		logger.info(`Listing sessions for working directory: ${opts.cwd}`);
		if (!opts.cwd) {
			return { sessions: [], next_cursor: null };
		}
		const sessions = await Session.list(opts.cwd);
		return {
			sessions: sessions.map((s) => ({
				cwd: opts.cwd!,
				session_id: s.id,
				title: s.title,
				updated_at: new Date(s.updatedAt * 1000).toISOString(),
			})),
			next_cursor: null,
		};
	}

	async setSessionMode(opts: {
		modeId: string;
		sessionId: string;
	}): Promise<void> {
		if (opts.modeId !== "default") {
			throw new Error("Only default mode is supported");
		}
	}

	async setSessionModel(opts: {
		modelId: string;
		sessionId: string;
	}): Promise<void> {
		logger.info(
			`Setting session model to ${opts.modelId} for session: ${opts.sessionId}`,
		);

		const entry = this.sessions.get(opts.sessionId);
		if (!entry) {
			logger.error(`Session not found: ${opts.sessionId}`);
			throw ACPRequestError.invalidParams({ session_id: "Session not found" });
		}

		const [acpSession, currentModelIdConv] = entry;
		const cli = acpSession.cli;
		const modelIdConv = _ModelIDConv.fromAcpModelId(opts.modelId);
		if (modelIdConv.equals(currentModelIdConv)) {
			return;
		}

		const config = cli.soul.runtime.config;
		const newModel = config.models[modelIdConv.modelKey];
		if (!newModel) {
			logger.error(`Model not found: ${modelIdConv.modelKey}`);
			throw ACPRequestError.invalidParams({ model_id: "Model not found" });
		}
		const newProvider = config.providers[newModel.provider];
		if (!newProvider) {
			logger.error(
				`Provider not found: ${newModel.provider} for model: ${modelIdConv.modelKey}`,
			);
			throw ACPRequestError.invalidParams({
				model_id: "Model's provider not found",
			});
		}

		const providerConfig: LLMProviderConfig = {
			type: (newProvider as any).type ?? "openai",
			baseUrl: (newProvider as any).base_url ?? "",
			apiKey: (newProvider as any).api_key ?? "",
			customHeaders: (newProvider as any).custom_headers,
			oauth: (newProvider as any).oauth?.key ?? null,
		};

		const modelConfig: LLMModelConfig = {
			model: newModel.model,
			provider: newModel.provider,
			maxContextSize: newModel.max_context_size,
			capabilities: newModel.capabilities,
		};

		const newLlm = createLLM(providerConfig, modelConfig, {
			thinking: modelIdConv.thinking,
			sessionId: acpSession.id,
		});
		cli.soul.runtime.llm = newLlm;

		config.default_model = modelIdConv.modelKey;
		config.default_thinking = modelIdConv.thinking;

		// Persist the model change
		try {
			const { config: configForSave } = await loadConfig();
			configForSave.default_model = modelIdConv.modelKey;
			configForSave.default_thinking = modelIdConv.thinking;
			await saveConfig(configForSave);
		} catch (e) {
			logger.warn(`Failed to persist model change: ${e}`);
		}

		// Update cached model ID conv
		this.sessions.set(opts.sessionId, [acpSession, modelIdConv]);
	}

	async authenticate(opts: {
		methodId: string;
	}): Promise<AuthenticateResponse | null> {
		if (opts.methodId === "login") {
			const reason = ACPServer._checkTokenUsable();
			if (reason === null) {
				logger.info(`Authentication successful for method: ${opts.methodId}`);
				return {};
			}
			logger.warn(
				`Authentication not complete for method: ${opts.methodId} (${reason})`,
			);
			throw ACPRequestError.authRequired({
				message: "Please complete login in terminal first",
				authMethods: this._authMethods,
			});
		}

		logger.error(`Unknown auth method: ${opts.methodId}`);
		throw ACPRequestError.invalidParams({ method_id: "Unknown auth method" });
	}

	async prompt(opts: {
		prompt: ACPContentBlock[];
		sessionId: string;
	}): Promise<PromptResponse> {
		logger.info(`Received prompt request for session: ${opts.sessionId}`);
		const entry = this.sessions.get(opts.sessionId);
		if (!entry) {
			logger.error(`Session not found: ${opts.sessionId}`);
			throw ACPRequestError.invalidParams({ session_id: "Session not found" });
		}
		const [acpSession] = entry;
		return await acpSession.prompt(opts.prompt);
	}

	async cancel(opts: { sessionId: string }): Promise<void> {
		logger.info(`Received cancel request for session: ${opts.sessionId}`);
		const entry = this.sessions.get(opts.sessionId);
		if (!entry) {
			logger.error(`Session not found: ${opts.sessionId}`);
			throw ACPRequestError.invalidParams({ session_id: "Session not found" });
		}
		const [acpSession] = entry;
		await acpSession.cancel();
	}
}

// ── Helpers ──────────────────────────────────────────────

function _defaultModeState(): SessionModeState {
	return {
		available_modes: [
			{
				id: "default",
				name: "Default",
				description: "The default mode.",
			},
		],
		current_mode_id: "default",
	};
}
