/**
 * Wire E2E test helpers — corresponds to Python's tests_e2e/wire_helpers.py
 * Provides WireProcess, startWire, sendInitialize, collectors, builders, and normalizers.
 */

import { Subprocess } from "bun";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ── Constants ─────────────────────────────────────────────────

const TRACE_ENV = "KIMI_TEST_TRACE";
const WIRE_COMMAND_ENV = "KIMI_E2E_WIRE_CMD";
export const DEFAULT_TIMEOUT = 5000; // ms

let _pathReplacements: Record<string, string> = {};

export function resetPathReplacements(): void {
  _pathReplacements = {};
}

// ── Path helpers ──────────────────────────────────────────────

export function repoRoot(): string {
  return path.resolve(__dirname, "..");
}

function printTrace(label: string, text: string): void {
  if (process.env[TRACE_ENV] === "1") {
    console.log("-----");
    console.log(`${label}: ${text}`);
  }
}

export function makeHomeDir(tmpPath: string): string {
  const homeDir = path.join(tmpPath, "home");
  fs.mkdirSync(homeDir, { recursive: true });
  registerPathReplacements({ tmpPath, homeDir });
  return homeDir;
}

export function makeWorkDir(tmpPath: string): string {
  const workDir = path.join(tmpPath, "work");
  fs.mkdirSync(workDir, { recursive: true });
  registerPathReplacements({ tmpPath, workDir });
  return workDir;
}

export function makeEnv(homeDir: string): Record<string, string> {
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  env.HOME = homeDir;
  env.USERPROFILE = homeDir;
  env.KIMI_SHARE_DIR = shareDir(homeDir);
  return env;
}

export function shareDir(homeDir: string): string {
  return path.join(homeDir, ".kimi");
}

export function registerPathReplacements(opts: {
  tmpPath?: string;
  homeDir?: string;
  workDir?: string;
}): void {
  if (opts.tmpPath) addReplacement(opts.tmpPath, "<tmp>");
  if (opts.homeDir) addReplacement(opts.homeDir, "<home_dir>");
  if (opts.workDir) addReplacement(opts.workDir, "<work_dir>");
}

function addReplacement(p: string, token: string): void {
  _pathReplacements[p] = token;
  const resolved = path.resolve(p);
  _pathReplacements[resolved] = token;
  // Also add the realpath if different (macOS /private/var/... vs /var/...)
  try {
    const real = fs.realpathSync(p);
    if (real !== p && real !== resolved) {
      _pathReplacements[real] = token;
    }
  } catch {
    // ignore
  }
}

// ── Scripts & Config ──────────────────────────────────────────

export function writeScriptsFile(
  tmpPath: string,
  scripts: string[],
  name = "scripts.json",
): string {
  const scriptsPath = path.join(tmpPath, name);
  fs.writeFileSync(scriptsPath, JSON.stringify(scripts), "utf-8");
  return scriptsPath;
}

export function writeScriptedConfig(
  tmpPath: string,
  scripts: string[],
  opts: {
    modelName?: string;
    providerName?: string;
    capabilities?: string[];
    loopControl?: Record<string, unknown>;
  } = {},
): string {
  const modelName = opts.modelName ?? "scripted";
  const providerName = opts.providerName ?? "scripted_provider";
  const scriptsPath = writeScriptsFile(tmpPath, scripts);

  const modelConfig: Record<string, unknown> = {
    provider: providerName,
    model: "scripted_echo",
    max_context_size: 100000,
  };
  if (opts.capabilities) {
    modelConfig.capabilities = opts.capabilities;
  }

  const configData: Record<string, unknown> = {
    default_model: modelName,
    models: { [modelName]: modelConfig },
    providers: {
      [providerName]: {
        type: "_scripted_echo",
        base_url: "",
        api_key: "",
        env: { KIMI_SCRIPTED_ECHO_SCRIPTS: scriptsPath },
      },
    },
  };
  if (opts.loopControl) {
    configData.loop_control = opts.loopControl;
  }

  const configPath = path.join(tmpPath, "config.json");
  fs.writeFileSync(configPath, JSON.stringify(configData), "utf-8");
  return configPath;
}

// ── Script line builders ──────────────────────────────────────

export function buildShellToolCall(toolCallId: string, command: string): string {
  const payload = {
    id: toolCallId,
    name: "Shell",
    arguments: JSON.stringify({ command }),
  };
  return `tool_call: ${JSON.stringify(payload)}`;
}

export function buildSetTodoCall(
  toolCallId: string,
  todos: Array<{ title: string; status: string }>,
): string {
  const payload = {
    id: toolCallId,
    name: "SetTodoList",
    arguments: JSON.stringify({ todos }),
  };
  return `tool_call: ${JSON.stringify(payload)}`;
}

export function buildAskUserToolCall(
  toolCallId: string,
  questions: Array<Record<string, unknown>>,
): string {
  const payload = {
    id: toolCallId,
    name: "AskUserQuestion",
    arguments: JSON.stringify({ questions }),
  };
  return `tool_call: ${JSON.stringify(payload)}`;
}

// ── Response builders ─────────────────────────────────────────

export function buildApprovalResponse(
  requestMsg: Record<string, unknown>,
  response: string,
): Record<string, unknown> {
  const requestId = requestMsg.id;
  const params = (requestMsg.params as Record<string, unknown>) ?? {};
  const payload = (params.payload as Record<string, unknown>) ?? {};
  const approvalId = payload.id;
  return {
    jsonrpc: "2.0",
    id: requestId,
    result: { request_id: approvalId, response },
  };
}

export function buildQuestionResponse(
  requestMsg: Record<string, unknown>,
  answers: Record<string, string>,
): Record<string, unknown> {
  const requestId = requestMsg.id;
  const params = (requestMsg.params as Record<string, unknown>) ?? {};
  const payload = (params.payload as Record<string, unknown>) ?? {};
  const questionId = payload.id;
  return {
    jsonrpc: "2.0",
    id: requestId,
    result: { request_id: questionId, answers },
  };
}

export function buildToolResultResponse(
  requestMsg: Record<string, unknown>,
  opts: { output: string; isError?: boolean },
): Record<string, unknown> {
  const params = (requestMsg.params as Record<string, unknown>) ?? {};
  const payload = (params.payload as Record<string, unknown>) ?? {};
  const toolCallId = payload.id;
  return {
    jsonrpc: "2.0",
    id: requestMsg.id,
    result: {
      tool_call_id: toolCallId,
      return_value: {
        is_error: opts.isError ?? false,
        output: opts.output,
        message: opts.isError ? "error" : "ok",
        display: [],
      },
    },
  };
}

// ── WireProcess ───────────────────────────────────────────────

export class WireProcess {
  private proc: Subprocess;
  private stdout: ReadableStream<Uint8Array>;
  private stdinSink: ReturnType<Subprocess["stdin"]>;
  private lineBuffer: string = "";
  private lineQueue: string[] = [];
  private lineWaiters: Array<{
    resolve: (line: string | null) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private reading = false;
  private eof = false;
  private decoder = new TextDecoder();
  private encoder = new TextEncoder();

  constructor(proc: Subprocess) {
    this.proc = proc;
    this.stdout = proc.stdout as ReadableStream<Uint8Array>;
    this.stdinSink = proc.stdin;
    this.reader = this.stdout.getReader();
    this._startReading();
  }

  private _startReading(): void {
    if (this.reading) return;
    this.reading = true;
    (async () => {
      try {
        while (true) {
          const { done, value } = await this.reader.read();
          if (done) {
            this.eof = true;
            this._flushWaiters();
            break;
          }
          this.lineBuffer += this.decoder.decode(value, { stream: true });
          this._processLines();
        }
      } catch {
        this.eof = true;
        this._flushWaiters();
      }
    })();
  }

  private _processLines(): void {
    const lines = this.lineBuffer.split("\n");
    // Keep the last incomplete segment
    this.lineBuffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // If someone is waiting, deliver directly
      if (this.lineWaiters.length > 0) {
        const waiter = this.lineWaiters.shift()!;
        clearTimeout(waiter.timer);
        waiter.resolve(trimmed);
      } else {
        this.lineQueue.push(trimmed);
      }
    }
  }

  private _flushWaiters(): void {
    while (this.lineWaiters.length > 0) {
      const waiter = this.lineWaiters.shift()!;
      clearTimeout(waiter.timer);
      waiter.resolve(null);
    }
  }

  private async _readLine(timeout: number): Promise<string | null> {
    // Check queue first
    if (this.lineQueue.length > 0) {
      return this.lineQueue.shift()!;
    }
    if (this.eof) return null;
    return new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => {
        const idx = this.lineWaiters.findIndex((w) => w.resolve === resolve);
        if (idx >= 0) this.lineWaiters.splice(idx, 1);
        resolve(null);
      }, timeout);
      this.lineWaiters.push({ resolve, timer });
    });
  }

  async sendJson(payload: Record<string, unknown>): Promise<void> {
    const line = JSON.stringify(payload);
    printTrace("STDIN", line);
    (this.stdinSink as any).write(this.encoder.encode(line + "\n"));
    (this.stdinSink as any).flush?.();
  }

  async sendRaw(line: string): Promise<void> {
    printTrace("STDIN", line);
    (this.stdinSink as any).write(this.encoder.encode(line + "\n"));
    (this.stdinSink as any).flush?.();
  }

  async readJson(timeout: number = DEFAULT_TIMEOUT): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeout;
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error("Timed out waiting for wire output");
      }
      const line = await this._readLine(remaining);
      if (line === null) {
        if (this.eof) {
          throw new Error("Wire process closed output stream");
        }
        throw new Error("Timed out waiting for wire output");
      }
      printTrace("STDOUT", line);
      try {
        const msg = JSON.parse(line);
        if (typeof msg === "object" && msg !== null) {
          return msg as Record<string, unknown>;
        }
      } catch {
        // Not JSON, skip
        continue;
      }
    }
  }

  async close(): Promise<void> {
    try {
      (this.stdinSink as any).end?.();
    } catch {
      // ignore
    }
    try {
      this.reader.cancel();
    } catch {
      // ignore
    }
    // Wait for process to exit
    try {
      const exitPromise = this.proc.exited;
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), 2000),
      );
      await Promise.race([exitPromise, timeoutPromise]);
    } catch {
      this.proc.kill();
      try {
        const exitPromise = this.proc.exited;
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), 2000),
        );
        await Promise.race([exitPromise, timeoutPromise]);
      } catch {
        this.proc.kill(9);
      }
    }
  }
}

// ── Start / Initialize ────────────────────────────────────────

export function baseCommand(): string[] {
  const override = process.env[WIRE_COMMAND_ENV]?.trim();
  if (override) {
    const parts = override.split(/\s+/).filter((p) => p !== "--wire");
    return parts;
  }
  return ["bun", "run", "src/kimi_cli_ts/index.ts"];
}

function wireBaseCommand(): string[] {
  const cmd = baseCommand();
  if (!cmd.includes("--wire")) {
    cmd.push("--wire");
  }
  return cmd;
}

export function startWire(opts: {
  configPath?: string;
  configText?: string;
  workDir: string;
  homeDir: string;
  extraArgs?: string[];
  yolo?: boolean;
  mcpConfigPath?: string;
  skillsDirs?: string[];
  agentFile?: string;
}): WireProcess {
  const cmd = wireBaseCommand();

  if (opts.yolo) cmd.push("--yolo");
  if (opts.configPath) cmd.push("--config-file", opts.configPath);
  if (opts.configText) cmd.push("--config", opts.configText);
  if (opts.mcpConfigPath) cmd.push("--mcp-config-file", opts.mcpConfigPath);
  for (const sd of opts.skillsDirs ?? []) {
    cmd.push("--skills-dir", sd);
  }
  if (opts.agentFile) cmd.push("--agent-file", opts.agentFile);
  if (opts.extraArgs) cmd.push(...opts.extraArgs);
  cmd.push("--work-dir", opts.workDir);

  const env = makeEnv(opts.homeDir);

  const proc = Bun.spawn(cmd, {
    cwd: repoRoot(),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env,
  });

  return new WireProcess(proc);
}

export async function sendInitialize(
  wire: WireProcess,
  opts?: {
    externalTools?: Array<Record<string, unknown>>;
    capabilities?: Record<string, unknown>;
  },
): Promise<Record<string, unknown>> {
  const params: Record<string, unknown> = { protocol_version: "1.1" };
  if (opts?.externalTools) {
    params.external_tools = opts.externalTools;
  }
  if (opts?.capabilities !== undefined) {
    params.capabilities = opts.capabilities;
  }
  await wire.sendJson({
    jsonrpc: "2.0",
    id: "init",
    method: "initialize",
    params,
  });
  return readResponse(wire, "init");
}

// ── Reading / Collecting ──────────────────────────────────────

export async function readResponse(
  wire: WireProcess,
  responseId: string,
): Promise<Record<string, unknown>> {
  while (true) {
    const msg = await wire.readJson();
    if (msg.id === responseId) {
      return msg;
    }
  }
}

export async function collectUntilResponse(
  wire: WireProcess,
  responseId: string,
  opts?: {
    requestHandler?: (msg: Record<string, unknown>) => Record<string, unknown>;
    timeout?: number;
  },
): Promise<[Record<string, unknown>, Array<Record<string, unknown>>]> {
  const messages: Array<Record<string, unknown>> = [];
  const readTimeout = opts?.timeout ?? DEFAULT_TIMEOUT;
  while (true) {
    const msg = await wire.readJson(readTimeout);
    if (msg.method === "event" || msg.method === "request") {
      messages.push(msg);
    }
    if (msg.method === "request" && opts?.requestHandler) {
      await wire.sendJson(opts.requestHandler(msg));
    }
    if (msg.id === responseId) {
      return [msg, messages];
    }
  }
}

export async function collectUntilRequest(
  wire: WireProcess,
): Promise<[Record<string, unknown>, Array<Record<string, unknown>>]> {
  const messages: Array<Record<string, unknown>> = [];
  while (true) {
    const msg = await wire.readJson();
    if (msg.method === "event" || msg.method === "request") {
      messages.push(msg);
    }
    if (msg.method === "request") {
      return [msg, messages];
    }
  }
}

// ── Normalization ─────────────────────────────────────────────

function replacePaths(
  value: string,
  replacements: Record<string, string>,
): string {
  if (!Object.keys(replacements).length) return value;
  // Sort by length descending so longer paths are replaced first
  const sorted = Object.entries(replacements).sort(
    (a, b) => b[0].length - a[0].length,
  );
  for (const [old, newVal] of sorted) {
    if (old && value.includes(old)) {
      value = value.split(old).join(newVal);
    }
  }
  return value;
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function normalizePathSeparators(
  value: string,
  replacements: Record<string, string>,
): string {
  if (!Object.keys(replacements).length) return value;
  const tokens = new Set(Object.values(replacements));
  if (!tokens.size) return value;
  for (const token of tokens) {
    if (value.includes(token)) {
      return value.replace(/\\/g, "/");
    }
  }
  return value;
}

function normalizeEchoErrorMessage(value: string): string {
  if (
    !value.startsWith("Invalid echo DSL at line") &&
    !value.startsWith("Unknown echo DSL kind")
  ) {
    return value;
  }
  if (!value.includes(": ")) return value;
  const idx = value.lastIndexOf(": ");
  const prefix = value.slice(0, idx);
  let raw = value.slice(idx + 2).trim();
  if (
    raw.length >= 2 &&
    raw[0] === raw[raw.length - 1] &&
    (raw[0] === "'" || raw[0] === '"')
  ) {
    raw = raw.slice(1, -1);
  }
  return `${prefix}: '${raw}'`;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function normalizeShellDisplay(value: Record<string, unknown>): Record<string, unknown> {
  if (value.type !== "shell") return value;
  const language = value.language;
  if (
    typeof language === "string" &&
    ["powershell", "pwsh"].includes(language.toLowerCase())
  ) {
    value.language = "bash";
  }
  return value;
}

function normalizeErrorData(value: Record<string, unknown>): Record<string, unknown> {
  const error = value.error;
  if (typeof error === "object" && error !== null && !("data" in (error as Record<string, unknown>))) {
    (error as Record<string, unknown>).data = null;
  }
  if ("code" in value && "message" in value && !("data" in value)) {
    value.data = null;
  }
  return value;
}

function normalizeToolResultExtras(value: Record<string, unknown>): Record<string, unknown> {
  const returnValue = value.return_value;
  if (
    typeof returnValue === "object" &&
    returnValue !== null &&
    !("extras" in (returnValue as Record<string, unknown>))
  ) {
    (returnValue as Record<string, unknown>).extras = null;
  }
  return value;
}

export function normalizeValue(
  value: unknown,
  replacements?: Record<string, string>,
): unknown {
  const activeReplacements = replacements ?? _pathReplacements;

  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    let normalized: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      normalized[k] = normalizeValue(v, activeReplacements);
    }
    normalized = normalizeShellDisplay(normalized);
    normalized = normalizeErrorData(normalized);
    normalized = normalizeToolResultExtras(normalized);
    return normalized;
  }

  if (Array.isArray(value)) {
    return value.map((v) => normalizeValue(v, activeReplacements));
  }

  if (typeof value === "number" && !Number.isInteger(value)) {
    return Math.round(value * 1e6) / 1e6;
  }

  if (typeof value === "string") {
    let s = replacePaths(value, activeReplacements);
    s = normalizeLineEndings(s);
    s = normalizePathSeparators(s, activeReplacements);
    s = normalizeEchoErrorMessage(s);
    if (isUuid(s)) return "<uuid>";
    return s;
  }

  return value;
}

function normalizeServerVersion(value: unknown): unknown {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    let obj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      obj[k] = normalizeServerVersion(v);
    }
    if (obj.name === "Kimi Code CLI" && "version" in obj) {
      obj = { ...obj, version: "<VERSION>" };
    }
    return obj;
  }
  if (Array.isArray(value)) {
    return value.map((v) => normalizeServerVersion(v));
  }
  return value;
}

export function normalizeResponse(
  msg: Record<string, unknown>,
  replacements?: Record<string, string>,
): Record<string, unknown> {
  if ("result" in msg) {
    let result = normalizeValue(msg.result, replacements);
    result = normalizeServerVersion(result);
    return { result } as Record<string, unknown>;
  }
  if ("error" in msg) {
    let normalized = { error: normalizeValue(msg.error, replacements) };
    return normalizeServerVersion(normalized) as Record<string, unknown>;
  }
  return normalizeServerVersion(
    normalizeValue(msg, replacements),
  ) as Record<string, unknown>;
}

// ── Message Summarization ─────────────────────────────────────

function orderToolResults(
  toolResults: Array<Record<string, unknown>>,
  toolCallOrder: string[],
): Array<Record<string, unknown>> {
  if (!toolCallOrder.length) return toolResults;
  const byId: Record<string, Array<Record<string, unknown>>> = {};
  const unknown: Array<Record<string, unknown>> = [];
  for (const msg of toolResults) {
    const payload = msg.payload as Record<string, unknown> | undefined;
    const toolCallId =
      typeof payload?.tool_call_id === "string" ? payload.tool_call_id : null;
    if (toolCallId && toolCallOrder.includes(toolCallId)) {
      if (!byId[toolCallId]) byId[toolCallId] = [];
      byId[toolCallId].push(msg);
    } else {
      unknown.push(msg);
    }
  }
  const ordered: Array<Record<string, unknown>> = [];
  for (const toolCallId of toolCallOrder) {
    ordered.push(...(byId[toolCallId] ?? []));
  }
  ordered.push(...unknown);
  return ordered;
}

function normalizeStepBlock(
  block: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  if (!block.length || block[0].type !== "StepBegin") return block;
  const head = block.slice(0, 1);
  const tail = block.slice(1);
  if (!tail.length) return block;

  const streamEvents: Array<Record<string, unknown>> = [];
  const statusUpdates: Array<Record<string, unknown>> = [];
  const requests: Array<Record<string, unknown>> = [];
  const approvals: Array<Record<string, unknown>> = [];
  const toolResults: Array<Record<string, unknown>> = [];
  const other: Array<Record<string, unknown>> = [];
  const toolCallOrder: string[] = [];

  for (const msg of tail) {
    const msgType = msg.type as string | undefined;
    const method = msg.method as string | undefined;

    if (msgType === "ToolCall") {
      const payload = msg.payload as Record<string, unknown> | undefined;
      const toolCallId =
        typeof payload?.id === "string" ? payload.id : null;
      if (toolCallId && !toolCallOrder.includes(toolCallId)) {
        toolCallOrder.push(toolCallId);
      }
    }

    if (
      msgType === "ContentPart" ||
      msgType === "ToolCall" ||
      msgType === "ToolCallPart"
    ) {
      streamEvents.push(msg);
    } else if (msgType === "StatusUpdate") {
      statusUpdates.push(msg);
    } else if (method === "request") {
      requests.push(msg);
    } else if (msgType === "ApprovalResponse") {
      approvals.push(msg);
    } else if (msgType === "ToolResult") {
      toolResults.push(msg);
    } else {
      other.push(msg);
    }
  }

  const orderedResults = orderToolResults(toolResults, toolCallOrder);
  return [
    ...head,
    ...streamEvents,
    ...statusUpdates,
    ...requests,
    ...approvals,
    ...orderedResults,
    ...other,
  ];
}

function normalizeMessageOrder(
  messages: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const normalized = [...messages];
  const stepBoundaries = new Set(["StepBegin", "TurnBegin", "CompactionBegin"]);
  let idx = 0;
  while (idx < normalized.length) {
    if (normalized[idx].type !== "StepBegin") {
      idx++;
      continue;
    }
    const start = idx;
    let end = start + 1;
    while (end < normalized.length) {
      const msgType = normalized[end].type as string | undefined;
      if (msgType && stepBoundaries.has(msgType)) break;
      end++;
    }
    const block = normalized.slice(start, end);
    const normalizedBlock = normalizeStepBlock(block);
    normalized.splice(start, end - start, ...normalizedBlock);
    idx = start + normalizedBlock.length;
  }
  return normalized;
}

export function summarizeMessages(
  messages: Array<Record<string, unknown>>,
  replacements?: Record<string, string>,
): Array<Record<string, unknown>> {
  const summary: Array<Record<string, unknown>> = [];
  for (const msg of messages) {
    const method = msg.method;
    if (method !== "event" && method !== "request") continue;
    const params = (msg.params ?? {}) as Record<string, unknown>;
    const entry: Record<string, unknown> = {
      method,
      type: params.type,
      payload: normalizeValue(params.payload, replacements),
    };
    summary.push(entry);
  }
  return normalizeMessageOrder(summary);
}

// ── Temp Directory Helper ─────────────────────────────────────

export function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kimi-e2e-"));
}

export function cleanupTmpDir(tmpPath: string): void {
  try {
    fs.rmSync(tmpPath, { recursive: true, force: true });
  } catch {
    // ignore
  }
}
