/**
 * Wire protocol event types.
 *
 * These mirror the Python Wire protocol types from `kimi_cli.wire.types`,
 * adapted to TypeScript with discriminated unions. Each event carries a
 * `type` string literal for exhaustive pattern matching.
 *
 * This is a temporary self-contained definition. Once `@moonshot-ai/core`
 * exposes the full Wire event set, this file will be replaced by re-exports.
 */

// ── Content Parts (re-defined locally to avoid coupling to kosong) ────

export interface TextPart {
  type: 'text';
  text: string;
}

export interface ThinkPart {
  type: 'think';
  think: string;
}

export interface ImageURLPart {
  type: 'image_url';
  imageUrl: { url: string; id?: string | undefined };
}

export interface AudioURLPart {
  type: 'audio_url';
  audioUrl: { url: string; id?: string | undefined };
}

export interface VideoURLPart {
  type: 'video_url';
  videoUrl: { url: string; id?: string | undefined };
}

export type ContentPart = TextPart | ThinkPart | ImageURLPart | AudioURLPart | VideoURLPart;

// ── Tool Call ─────────────────────────────────────────────────────────

export interface ToolCallFunction {
  name: string;
  arguments: string | null;
}

export interface ToolCall {
  type: 'function';
  id: string;
  function: ToolCallFunction;
}

export interface ToolCallPart {
  type: 'tool_call_part';
  argumentsPart: string | null;
  index?: number | string | undefined;
}

// ── Display Blocks ────────────────────────────────────────────────────

export interface BriefDisplayBlock {
  type: 'brief';
  text: string;
}

export interface DiffDisplayBlock {
  type: 'diff';
  path: string;
  oldText: string;
  newText: string;
  oldStart?: number | undefined;
  newStart?: number | undefined;
  isSummary?: boolean | undefined;
}

export interface ShellDisplayBlock {
  type: 'shell';
  language: string;
  command: string;
}

export interface TodoDisplayItem {
  title: string;
  status: 'pending' | 'in_progress' | 'done';
}

export interface TodoDisplayBlock {
  type: 'todo';
  items: TodoDisplayItem[];
}

export interface BackgroundTaskDisplayBlock {
  type: 'background_task';
  taskId: string;
  kind: string;
  status: string;
  description: string;
}

export interface UnknownDisplayBlock {
  type: 'unknown';
  data: unknown;
}

export type DisplayBlock =
  | BriefDisplayBlock
  | DiffDisplayBlock
  | ShellDisplayBlock
  | TodoDisplayBlock
  | BackgroundTaskDisplayBlock
  | UnknownDisplayBlock;

// ── Tool Result ───────────────────────────────────────────────────────

export interface ToolReturnValue {
  isError: boolean;
  output: string | ContentPart[];
  message: string;
  display: DisplayBlock[];
}

// ── Token Usage ───────────────────────────────────────────────────────

export interface TokenUsage {
  inputOther: number;
  output: number;
  inputCacheRead: number;
  inputCacheCreation: number;
}

// ── MCP Status ────────────────────────────────────────────────────────

export interface MCPServerSnapshot {
  name: string;
  status: 'pending' | 'connecting' | 'connected' | 'failed' | 'unauthorized';
  tools: string[];
}

export interface MCPStatusSnapshot {
  loading: boolean;
  connected: number;
  total: number;
  tools: number;
  servers: MCPServerSnapshot[];
}

// ── Lifecycle Events ──────────────────────────────────────────────────

export interface TurnBeginEvent {
  type: 'TurnBegin';
  userInput: string | ContentPart[];
}

export interface TurnEndEvent {
  type: 'TurnEnd';
}

export interface StepBeginEvent {
  type: 'StepBegin';
  n: number;
}

export interface StepInterruptedEvent {
  type: 'StepInterrupted';
}

export interface CompactionBeginEvent {
  type: 'CompactionBegin';
}

export interface CompactionEndEvent {
  type: 'CompactionEnd';
}

// ── Content Events ────────────────────────────────────────────────────

export interface ContentPartEvent {
  type: 'ContentPart';
  part: ContentPart;
}

export interface ToolCallEvent {
  type: 'ToolCall';
  toolCall: ToolCall;
}

export interface ToolCallPartEvent {
  type: 'ToolCallPart';
  toolCallPart: ToolCallPart;
}

export interface ToolResultEvent {
  type: 'ToolResult';
  toolCallId: string;
  returnValue: ToolReturnValue;
}

// ── Status Events ─────────────────────────────────────────────────────

export interface StatusUpdateEvent {
  type: 'StatusUpdate';
  contextUsage?: number | undefined;
  contextTokens?: number | undefined;
  maxContextTokens?: number | undefined;
  tokenUsage?: TokenUsage | undefined;
  messageId?: string | undefined;
  planMode?: boolean | undefined;
  mcpStatus?: MCPStatusSnapshot | undefined;
}

export interface NotificationEvent {
  type: 'Notification';
  id: string;
  category: string;
  notificationType: string;
  sourceKind: string;
  sourceId: string;
  title: string;
  body: string;
  severity: string;
  createdAt: number;
  payload: Record<string, unknown>;
}

// ── Hook Events ───────────────────────────────────────────────────────

export interface HookTriggeredEvent {
  type: 'HookTriggered';
  event: string;
  target: string;
  hookCount: number;
}

export interface HookResolvedEvent {
  type: 'HookResolved';
  event: string;
  target: string;
  action: 'allow' | 'block';
  reason: string;
  durationMs: number;
}

// ── MCP Loading Events ────────────────────────────────────────────────

export interface MCPLoadingBeginEvent {
  type: 'MCPLoadingBegin';
}

export interface MCPLoadingEndEvent {
  type: 'MCPLoadingEnd';
}

// ── Request Events (Agent -> Client) ──────────────────────────────────

export interface ApprovalRequestEvent {
  type: 'ApprovalRequest';
  id: string;
  toolCallId: string;
  sender: string;
  action: string;
  description: string;
  sourceKind?: string | undefined;
  sourceId?: string | undefined;
  agentId?: string | undefined;
  subagentType?: string | undefined;
  sourceDescription?: string | undefined;
  display: DisplayBlock[];
}

export interface QuestionOption {
  label: string;
  description: string;
}

export interface QuestionItem {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
  body: string;
  otherLabel: string;
  otherDescription: string;
}

export interface QuestionRequestEvent {
  type: 'QuestionRequest';
  id: string;
  toolCallId: string;
  questions: QuestionItem[];
}

export interface HookRequestEvent {
  type: 'HookRequest';
  id: string;
  subscriptionId: string;
  event: string;
  target: string;
  inputData: Record<string, unknown>;
}

export interface ToolCallRequestEvent {
  type: 'ToolCallRequest';
  id: string;
  name: string;
  arguments: string | null;
}

// ── Response Events (Client -> Agent) ─────────────────────────────────

export interface ApprovalResponseEvent {
  type: 'ApprovalResponse';
  requestId: string;
  response: 'approve' | 'approve_for_session' | 'reject';
  feedback: string;
}

// ── Other Events ──────────────────────────────────────────────────────

export interface SteerInputEvent {
  type: 'SteerInput';
  userInput: string | ContentPart[];
}

export interface PlanDisplayEvent {
  type: 'PlanDisplay';
  content: string;
  filePath: string;
}

export interface BtwBeginEvent {
  type: 'BtwBegin';
  id: string;
  question: string;
}

export interface BtwEndEvent {
  type: 'BtwEnd';
  id: string;
  response: string | null;
  error: string | null;
}

export interface SubagentEventWrapper {
  type: 'SubagentEvent';
  parentToolCallId: string | null;
  agentId: string | null;
  subagentType: string | null;
  event: WireEvent;
}

// ── Union Types ───────────────────────────────────────────────────────

/**
 * All possible Wire events. Use the `type` discriminant for exhaustive
 * pattern matching in switch statements.
 */
export type WireEvent =
  // Lifecycle
  | TurnBeginEvent
  | TurnEndEvent
  | StepBeginEvent
  | StepInterruptedEvent
  | CompactionBeginEvent
  | CompactionEndEvent
  // Content
  | ContentPartEvent
  | ToolCallEvent
  | ToolCallPartEvent
  | ToolResultEvent
  // Status
  | StatusUpdateEvent
  | NotificationEvent
  // Hooks
  | HookTriggeredEvent
  | HookResolvedEvent
  // MCP
  | MCPLoadingBeginEvent
  | MCPLoadingEndEvent
  // Requests (agent -> client)
  | ApprovalRequestEvent
  | QuestionRequestEvent
  | HookRequestEvent
  | ToolCallRequestEvent
  // Responses (client -> agent)
  | ApprovalResponseEvent
  // Other
  | SteerInputEvent
  | PlanDisplayEvent
  | BtwBeginEvent
  | BtwEndEvent
  | SubagentEventWrapper;

// ── Type Guards ───────────────────────────────────────────────────────

/** Check if a WireEvent is a content part event. */
export function isContentPartEvent(event: WireEvent): event is ContentPartEvent {
  return event.type === 'ContentPart';
}

/** Check if a WireEvent is a text content part. */
export function isTextContentEvent(event: WireEvent): event is ContentPartEvent & { part: TextPart } {
  return event.type === 'ContentPart' && event.part.type === 'text';
}

/** Check if a WireEvent is a think content part. */
export function isThinkContentEvent(event: WireEvent): event is ContentPartEvent & { part: ThinkPart } {
  return event.type === 'ContentPart' && event.part.type === 'think';
}

/** Check if a WireEvent is an event that requests user interaction. */
export function isRequestEvent(
  event: WireEvent,
): event is ApprovalRequestEvent | QuestionRequestEvent | HookRequestEvent | ToolCallRequestEvent {
  return (
    event.type === 'ApprovalRequest' ||
    event.type === 'QuestionRequest' ||
    event.type === 'HookRequest' ||
    event.type === 'ToolCallRequest'
  );
}
