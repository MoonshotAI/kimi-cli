import { apiCache } from "./cache.ts";

const BASE = "/api/vis";

/** Simple concurrency limiter for batching API requests. */
class ConcurrencyLimiter {
  private running = 0;
  private queue: (() => void)[] = [];

  constructor(private maxConcurrent: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    while (this.running >= this.maxConcurrent) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      this.queue.shift()?.();
    }
  }
}

/** Limit concurrent summary requests to avoid overwhelming the backend. */
const summaryLimiter = new ConcurrencyLimiter(3);

async function fetchJSON<T>(path: string, timeoutMs = 30_000): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${path}`, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`API error: ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as T;
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      throw new Error("Request timed out");
    }
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

export interface SessionMetadataInfo {
  session_id: string;
  title: string;
  title_generated: boolean;
  archived: boolean;
  archived_at: number | null;
  auto_archive_exempt: boolean;
  wire_mtime: number | null;
}

export interface SessionInfo {
  session_id: string;
  session_dir: string;
  work_dir: string | null;
  work_dir_hash: string;
  title: string;
  last_updated: number;
  has_wire: boolean;
  has_context: boolean;
  has_state: boolean;
  metadata: SessionMetadataInfo | null;
  wire_size: number;
  context_size: number;
  state_size: number;
  total_size: number;
  turns: number;
  imported?: boolean;
  subagent_count?: number;
}

export interface SessionSummary {
  turns: number;
  steps: number;
  tool_calls: number;
  errors: number;
  compactions: number;
  duration_sec: number;
  input_tokens: number;
  output_tokens: number;
  wire_size: number;
  context_size: number;
  state_size: number;
  total_size: number;
}

export interface WireEvent {
  index: number;
  timestamp: number;
  type: string;
  payload: Record<string, unknown>;
}

export interface WireResponse {
  total: number;
  events: WireEvent[];
}

export interface ContextMessage {
  index: number;
  role: string;
  content?: ContentPart[] | string;
  tool_calls?: ToolCallItem[];
  tool_call_id?: string;
  name?: string;
  partial?: boolean;
  // _usage / _checkpoint special fields
  token_count?: number;
  id?: number;
  [key: string]: unknown;
}

/** Normalize content to always be an array of ContentPart. */
export function normalizeContent(
  content: ContentPart[] | string | undefined | null,
): ContentPart[] {
  if (!content) return [];
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  if (Array.isArray(content)) return content;
  return [];
}

export interface ContentPart {
  type: string;
  // TextPart
  text?: string;
  // ThinkPart (actual field name is "think", not "thinking")
  think?: string;
  thinking?: string;
  encrypted?: string;
  // ImageURLPart
  image_url?: { url: string; id?: string };
  // AudioURLPart
  audio_url?: { url: string; id?: string };
  // VideoURLPart
  video_url?: { url: string; id?: string };
  [key: string]: unknown;
}

export interface ToolCallItem {
  id: string;
  type: string;
  function: {
    name: string;
    arguments: string;
  };
  extras?: Record<string, unknown>;
}

export interface ContextResponse {
  total: number;
  messages: ContextMessage[];
}

export function listSessions(forceRefresh = false): Promise<SessionInfo[]> {
  if (forceRefresh) apiCache.invalidate("sessions");
  return apiCache.get("sessions", () => fetchJSON<SessionInfo[]>("/sessions", 120_000), 30_000);
}

const CONTENT_PART_MAP: Record<string, string> = {
  text: "TextPart",
  think: "ThinkPart",
};

/** Resolve ContentPart subtypes so the rest of the frontend can match on
 *  "TextPart" / "ThinkPart" instead of checking payload.type.
 *  Also recurses into SubagentEvent inner events. */
function normalizeWireEvents(res: WireResponse): WireResponse {
  return {
    ...res,
    events: res.events.map((e) => {
      // Top-level ContentPart
      if (e.type === "ContentPart" && typeof e.payload.type === "string") {
        const mapped = CONTENT_PART_MAP[e.payload.type];
        if (mapped) return { ...e, type: mapped };
      }
      // SubagentEvent: normalize nested event
      if (e.type === "SubagentEvent" && e.payload.event && typeof e.payload.event === "object") {
        const inner = e.payload.event as Record<string, unknown>;
        if (inner.type === "ContentPart" && inner.payload && typeof inner.payload === "object") {
          const innerPayload = inner.payload as Record<string, unknown>;
          const mapped = CONTENT_PART_MAP[innerPayload.type as string];
          if (mapped) {
            return { ...e, payload: { ...e.payload, event: { ...inner, type: mapped } } };
          }
        }
      }
      return e;
    }),
  };
}

export function getWireEvents(sessionId: string, forceRefresh = false): Promise<WireResponse> {
  const key = `wire:${sessionId}`;
  if (forceRefresh) apiCache.invalidate(key);
  return apiCache.get(key, () =>
    fetchJSON<WireResponse>(`/sessions/${sessionId}/wire`).then(normalizeWireEvents),
  );
}

export function getContextMessages(
  sessionId: string,
  forceRefresh = false,
): Promise<ContextResponse> {
  const key = `context:${sessionId}`;
  if (forceRefresh) apiCache.invalidate(key);
  return apiCache.get(key, () => fetchJSON<ContextResponse>(`/sessions/${sessionId}/context`));
}

export function getSessionState(
  sessionId: string,
  forceRefresh = false,
): Promise<Record<string, unknown>> {
  const key = `state:${sessionId}`;
  if (forceRefresh) apiCache.invalidate(key);
  return apiCache.get(key, () => fetchJSON<Record<string, unknown>>(`/sessions/${sessionId}/state`));
}

export interface AggregateStats {
  total_sessions: number;
  total_turns: number;
  total_tokens: { input: number; output: number };
  total_duration_sec: number;
  tool_usage: { name: string; count: number; error_count: number }[];
  daily_usage: { date: string; sessions: number; turns: number }[];
  per_project: { work_dir: string; sessions: number; turns: number }[];
}

export interface VisCapabilities {
  open_in_supported: boolean;
}

export function getAggregateStats(forceRefresh = false): Promise<AggregateStats> {
  const key = "aggregate-stats";
  if (forceRefresh) apiCache.invalidate(key);
  return apiCache.get(key, () => fetchJSON<AggregateStats>("/statistics"), 60_000);
}

export function getVisCapabilities(forceRefresh = false): Promise<VisCapabilities> {
  const key = "vis-capabilities";
  if (forceRefresh) apiCache.invalidate(key);
  return apiCache.get(key, () => fetchJSON<VisCapabilities>("/capabilities"), 60_000);
}

export function getSessionDownloadUrl(sessionId: string): string {
  return `${BASE}/sessions/${sessionId}/download`;
}

type OpenInApp = "finder";

export async function openInPath(app: OpenInApp, path: string): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch("/api/open-in", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app, path }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.json().catch(() => ({}));
      throw new Error(detail.detail || `Open failed: ${res.status}`);
    }
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      throw new Error("Open request timed out");
    }
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

export function getSessionSummary(
  sessionId: string,
  forceRefresh = false,
): Promise<SessionSummary> {
  const key = `summary:${sessionId}`;
  if (forceRefresh) apiCache.invalidate(key);
  return apiCache.get(key, () =>
    summaryLimiter.run(() => fetchJSON<SessionSummary>(`/sessions/${sessionId}/summary`)),
  );
}

export async function importSession(file: File): Promise<{ session_id: string; work_dir_hash: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  try {
    const formData = new FormData();
    formData.append("file", file);
    const res = await fetch(`${BASE}/sessions/import`, { method: "POST", body: formData, signal: controller.signal });
    if (!res.ok) {
      const detail = await res.json().catch(() => ({}));
      throw new Error(detail.detail || `Import failed: ${res.status}`);
    }
    apiCache.invalidate("sessions");
    return res.json();
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      throw new Error("Import request timed out");
    }
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

export type SubagentStatus =
  | "idle"
  | "running_foreground"
  | "running_background"
  | "completed"
  | "failed"
  | "killed";

export interface SubagentInfo {
  agent_id: string;
  subagent_type: string;
  status: SubagentStatus;
  description: string;
  created_at: number;
  updated_at: number;
  last_task_id: string | null;
  wire_size: number;
  context_size: number;
  launch_spec: Record<string, unknown>;
}

export function getSubagents(sessionId: string, forceRefresh = false): Promise<SubagentInfo[]> {
  const key = `subagents:${sessionId}`;
  if (forceRefresh) apiCache.invalidate(key);
  return apiCache.get(key, () => fetchJSON<SubagentInfo[]>(`/sessions/${sessionId}/subagents`));
}

export function getSubagentWireEvents(sessionId: string, agentId: string, forceRefresh = false): Promise<WireResponse> {
  const key = `subagent-wire:${sessionId}:${agentId}`;
  if (forceRefresh) apiCache.invalidate(key);
  return apiCache.get(key, () =>
    fetchJSON<WireResponse>(`/sessions/${sessionId}/subagents/${agentId}/wire`).then(normalizeWireEvents),
  );
}

export function getSubagentContextMessages(sessionId: string, agentId: string, forceRefresh = false): Promise<ContextResponse> {
  const key = `subagent-context:${sessionId}:${agentId}`;
  if (forceRefresh) apiCache.invalidate(key);
  return apiCache.get(key, () => fetchJSON<ContextResponse>(`/sessions/${sessionId}/subagents/${agentId}/context`));
}

export async function deleteSession(sessionId: string): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(`${BASE}/sessions/${sessionId}`, { method: "DELETE", signal: controller.signal });
    if (!res.ok) {
      const detail = await res.json().catch(() => ({}));
      throw new Error(detail.detail || `Delete failed: ${res.status}`);
    }
    apiCache.invalidate("sessions");
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      throw new Error("Delete request timed out");
    }
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}
