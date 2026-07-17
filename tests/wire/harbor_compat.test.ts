/**
 * Harbor wire protocol compatibility tests.
 *
 * Verifies that the TS --wire mode output can be consumed by Harbor's
 * KimiCli agent parser (harbor/agents/installed/kimi_cli.py).
 *
 * Harbor parses JSON-RPC lines with format:
 *   {"jsonrpc":"2.0","method":"event","params":{"type":"<EventType>","payload":{...}}}
 *
 * Critical format requirements from Harbor's parser:
 * 1. Text events use type "ContentPart" (Python serializes TextPart/ThinkPart as ContentPart)
 * 2. ToolCall uses nested {type:"function", id, function:{name, arguments}}
 * 3. ToolResult uses snake_case is_error (not camelCase isError)
 * 4. StatusUpdate token_usage uses {input_other, output, input_cache_read, input_cache_creation}
 * 5. ToolCallPart uses {arguments_part: "..."}
 */

import { describe, test, expect } from "bun:test";

// ── Harbor's expected wire samples ──────────────────────────
// Copied verbatim from harbor/tests/unit/agents/installed/test_kimi_cli.py

const WIRE_SIMPLE = [
  '{"jsonrpc":"2.0","method":"event","params":{"type":"TurnBegin","payload":{"user_input":"Say hello"}}}',
  '{"jsonrpc":"2.0","method":"event","params":{"type":"StepBegin","payload":{"n":1}}}',
  '{"jsonrpc":"2.0","method":"event","params":{"type":"ContentPart","payload":{"type":"text","text":"Hello"}}}',
  '{"jsonrpc":"2.0","method":"event","params":{"type":"ContentPart","payload":{"type":"text","text":" there!"}}}',
  '{"jsonrpc":"2.0","method":"event","params":{"type":"StatusUpdate","payload":{"context_usage":0.046,"token_usage":{"input_other":1247,"output":8,"input_cache_read":4864,"input_cache_creation":0},"message_id":"msg-1"}}}',
  '{"jsonrpc":"2.0","method":"event","params":{"type":"TurnEnd","payload":{}}}}',
  '{"jsonrpc":"2.0","id":"1","result":{"status":"finished"}}',
];

const WIRE_TOOL_CALLS = [
  '{"jsonrpc":"2.0","method":"event","params":{"type":"TurnBegin","payload":{"user_input":"Read hello.py and run it"}}}',
  '{"jsonrpc":"2.0","method":"event","params":{"type":"StepBegin","payload":{"n":1}}}',
  '{"jsonrpc":"2.0","method":"event","params":{"type":"ContentPart","payload":{"type":"text","text":"I\'ll read the file."}}}',
  '{"jsonrpc":"2.0","method":"event","params":{"type":"ToolCall","payload":{"type":"function","id":"ReadFile:0","function":{"name":"ReadFile","arguments":""},"extras":null}}}',
  '{"jsonrpc":"2.0","method":"event","params":{"type":"ToolCallPart","payload":{"arguments_part":"{\\""}}}',
  '{"jsonrpc":"2.0","method":"event","params":{"type":"ToolCallPart","payload":{"arguments_part":"path"}}}',
  '{"jsonrpc":"2.0","method":"event","params":{"type":"ToolCallPart","payload":{"arguments_part":"\\":"}}}',
  '{"jsonrpc":"2.0","method":"event","params":{"type":"ToolCallPart","payload":{"arguments_part":" \\"/app/hello.py"}}}',
  '{"jsonrpc":"2.0","method":"event","params":{"type":"ToolCallPart","payload":{"arguments_part":"\\"}"}}}',
  '{"jsonrpc":"2.0","method":"event","params":{"type":"StatusUpdate","payload":{"context_usage":0.045,"token_usage":{"input_other":1143,"output":40,"input_cache_read":4864,"input_cache_creation":0},"message_id":"msg-2"}}}',
  '{"jsonrpc":"2.0","method":"event","params":{"type":"ToolResult","payload":{"tool_call_id":"ReadFile:0","return_value":{"is_error":false,"output":"print(\'hello world\')\\n","message":"1 lines read","display":[],"extras":null}}}}',
  '{"jsonrpc":"2.0","method":"event","params":{"type":"StepBegin","payload":{"n":2}}}',
  '{"jsonrpc":"2.0","method":"event","params":{"type":"ContentPart","payload":{"type":"text","text":"Now let me run it."}}}',
  '{"jsonrpc":"2.0","method":"event","params":{"type":"ToolCall","payload":{"type":"function","id":"Shell:1","function":{"name":"Shell","arguments":""},"extras":null}}}',
  '{"jsonrpc":"2.0","method":"event","params":{"type":"ToolCallPart","payload":{"arguments_part":"{\\"command\\": \\"python3 hello.py\\"}"}}}',
  '{"jsonrpc":"2.0","method":"event","params":{"type":"StatusUpdate","payload":{"context_usage":0.046,"token_usage":{"input_other":205,"output":27,"input_cache_read":5888,"input_cache_creation":0},"message_id":"msg-3"}}}',
  '{"jsonrpc":"2.0","method":"event","params":{"type":"ToolResult","payload":{"tool_call_id":"Shell:1","return_value":{"is_error":false,"output":"hello world\\n","message":"Command executed successfully.","display":[],"extras":null}}}}',
  '{"jsonrpc":"2.0","method":"event","params":{"type":"StepBegin","payload":{"n":3}}}',
  '{"jsonrpc":"2.0","method":"event","params":{"type":"ContentPart","payload":{"type":"text","text":"The output is: hello world"}}}',
  '{"jsonrpc":"2.0","method":"event","params":{"type":"StatusUpdate","payload":{"context_usage":0.047,"token_usage":{"input_other":261,"output":20,"input_cache_read":5888,"input_cache_creation":0},"message_id":"msg-4"}}}',
  '{"jsonrpc":"2.0","method":"event","params":{"type":"TurnEnd","payload":{}}}}',
  '{"jsonrpc":"2.0","id":"1","result":{"status":"finished"}}',
];

// ── Helpers ─────────────────────────────────────────────────

/** Parse a Harbor wire line into its params (type + payload). */
function parseHarborEvent(line: string): { type: string; payload: Record<string, unknown> } | null {
  const msg = JSON.parse(line);
  if (msg.method === "event") {
    return msg.params;
  }
  return null;
}

/** Filter only event lines from the sample data. */
function harborEvents(lines: string[]): { type: string; payload: Record<string, unknown> }[] {
  return lines
    .map((l) => {
      try { return parseHarborEvent(l); } catch { return null; }
    })
    .filter((e): e is { type: string; payload: Record<string, unknown> } => e !== null);
}

// ── Step grouping (mirrors Harbor's _group_events_into_steps) ──

interface WireStep {
  n: number;
  textParts: string[];
  reasoningParts: string[];
  toolCalls: { id: string; name: string; arguments: Record<string, unknown> }[];
  toolResults: Record<string, Record<string, unknown>>;
  tokenUsage: Record<string, unknown> | null;
  pendingToolCallId: string | null;
  pendingToolName: string | null;
  pendingArgBuf: string;
}

function groupEventsIntoSteps(events: { type: string; payload: Record<string, unknown> }[]): WireStep[] {
  const steps: WireStep[] = [];
  let current: WireStep | null = null;

  function finalizePending() {
    if (!current || !current.pendingToolCallId) return;
    let args: Record<string, unknown>;
    try {
      args = current.pendingArgBuf ? JSON.parse(current.pendingArgBuf) : {};
    } catch {
      args = current.pendingArgBuf ? { raw: current.pendingArgBuf } : {};
    }
    current.toolCalls.push({ id: current.pendingToolCallId, name: current.pendingToolName || "", arguments: args });
    current.pendingToolCallId = null;
    current.pendingToolName = null;
    current.pendingArgBuf = "";
  }

  for (const { type, payload } of events) {
    if (type === "StepBegin") {
      if (current) { finalizePending(); steps.push(current); }
      current = { n: (payload.n as number) || steps.length + 1, textParts: [], reasoningParts: [], toolCalls: [], toolResults: {}, tokenUsage: null, pendingToolCallId: null, pendingToolName: null, pendingArgBuf: "" };
      continue;
    }
    if (!current) continue;
    if (type === "ContentPart") {
      if (payload.type === "text") current.textParts.push((payload.text as string) || "");
    } else if (type === "ThinkPart") {
      current.reasoningParts.push((payload.think as string) || "");
    } else if (type === "ToolCall") {
      finalizePending();
      const func = payload.function as Record<string, unknown>;
      current.pendingToolCallId = (payload.id as string) || "";
      current.pendingToolName = (func.name as string) || "";
      current.pendingArgBuf = (func.arguments as string) || "";
    } else if (type === "ToolCallPart") {
      if (current.pendingToolCallId) current.pendingArgBuf += (payload.arguments_part as string) || "";
    } else if (type === "ToolResult") {
      finalizePending();
      current.toolResults[payload.tool_call_id as string] = payload.return_value as Record<string, unknown>;
    } else if (type === "StatusUpdate") {
      current.tokenUsage = payload.token_usage as Record<string, unknown>;
    } else if (type === "TurnEnd") {
      finalizePending();
      steps.push(current);
      current = null;
    }
  }
  if (current) { finalizePending(); steps.push(current); }
  return steps;
}

// ── Tests ───────────────────────────────────────────────────

describe("Harbor wire — event type names", () => {
  test("text events use type TextPart", () => {
    const events = harborEvents(WIRE_SIMPLE);
    const textEvents = events.filter(e => e.payload.type === "text");
    expect(textEvents.length).toBeGreaterThan(0);
    for (const e of textEvents) {
      expect(e.type).toBe("ContentPart");
    }
  });
});

describe("Harbor wire — ToolCall format", () => {
  test("ToolCall uses nested function object", () => {
    const events = harborEvents(WIRE_TOOL_CALLS);
    const toolCalls = events.filter(e => e.type === "ToolCall");
    expect(toolCalls.length).toBe(2);
    for (const tc of toolCalls) {
      expect(tc.payload.type).toBe("function");
      expect(tc.payload.id).toBeDefined();
      expect(tc.payload.function).toBeDefined();
      const func = tc.payload.function as Record<string, unknown>;
      expect(func.name).toBeDefined();
      expect(typeof func.arguments).toBe("string");
    }
  });

  test("ToolCallPart uses arguments_part field", () => {
    const events = harborEvents(WIRE_TOOL_CALLS);
    const parts = events.filter(e => e.type === "ToolCallPart");
    expect(parts.length).toBeGreaterThan(0);
    for (const p of parts) {
      expect(typeof p.payload.arguments_part).toBe("string");
    }
  });
});

describe("Harbor wire — ToolResult format", () => {
  test("ToolResult uses is_error (snake_case)", () => {
    const events = harborEvents(WIRE_TOOL_CALLS);
    const results = events.filter(e => e.type === "ToolResult");
    for (const r of results) {
      const retval = r.payload.return_value as Record<string, unknown>;
      expect("is_error" in retval).toBe(true);
    }
  });

  test("ToolResult uses tool_call_id (snake_case)", () => {
    const events = harborEvents(WIRE_TOOL_CALLS);
    const results = events.filter(e => e.type === "ToolResult");
    for (const r of results) {
      expect("tool_call_id" in r.payload).toBe(true);
    }
  });
});

describe("Harbor wire — StatusUpdate token_usage format", () => {
  test("token_usage uses Harbor field names", () => {
    const events = harborEvents(WIRE_SIMPLE);
    const su = events.find(e => e.type === "StatusUpdate");
    expect(su).toBeDefined();
    const tu = su!.payload.token_usage as Record<string, number>;
    expect(tu.input_other).toBe(1247);
    expect(tu.output).toBe(8);
    expect(tu.input_cache_read).toBe(4864);
    expect(tu.input_cache_creation).toBe(0);
  });
});

describe("Harbor wire — step grouping from events", () => {
  test("simple text: 1 step", () => {
    const steps = groupEventsIntoSteps(harborEvents(WIRE_SIMPLE));
    expect(steps.length).toBe(1);
    expect(steps[0].textParts.join("")).toBe("Hello there!");
    expect((steps[0].tokenUsage as any).input_other).toBe(1247);
  });

  test("tool calls: 3 steps", () => {
    const steps = groupEventsIntoSteps(harborEvents(WIRE_TOOL_CALLS));
    expect(steps.length).toBe(3);
    expect(steps[0].toolCalls[0].name).toBe("ReadFile");
    expect(steps[0].toolCalls[0].arguments).toEqual({ path: "/app/hello.py" });
    expect(steps[0].toolResults["ReadFile:0"]).toBeDefined();
    expect(steps[1].toolCalls[0].name).toBe("Shell");
    expect(steps[1].toolCalls[0].arguments).toEqual({ command: "python3 hello.py" });
    expect(steps[2].toolCalls.length).toBe(0);
    expect(steps[2].textParts.join("")).toContain("hello world");
  });

  test("token metrics match Harbor expectations", () => {
    const steps = groupEventsIntoSteps(harborEvents(WIRE_TOOL_CALLS));
    let totalPrompt = 0, totalCompletion = 0, totalCached = 0;
    for (const step of steps) {
      if (step.tokenUsage) {
        const tu = step.tokenUsage as Record<string, number>;
        totalPrompt += (tu.input_other || 0) + (tu.input_cache_read || 0) + (tu.input_cache_creation || 0);
        totalCompletion += tu.output || 0;
        totalCached += tu.input_cache_read || 0;
      }
    }
    expect(totalPrompt).toBe((1143+4864) + (205+5888) + (261+5888));
    expect(totalCompletion).toBe(40 + 27 + 20);
    expect(totalCached).toBe(4864 + 5888 + 5888);
  });
});

describe("Harbor wire — final result message", () => {
  test("final result message format", () => {
    const finalLine = WIRE_SIMPLE[WIRE_SIMPLE.length - 1];
    const msg = JSON.parse(finalLine);
    expect(msg.jsonrpc).toBe("2.0");
    expect(msg.id).toBe("1");
    expect(msg.result.status).toBe("finished");
    expect(msg.method).toBeUndefined();
  });
});

describe("Harbor wire — multiline ToolResult", () => {
  test("ToolResult with literal control characters", () => {
    const line = '{"jsonrpc":"2.0","method":"event","params":{"type":"ToolResult","payload":{"tool_call_id":"ReadFile:0","return_value":{"is_error":false,"output":"     1\\tdef foo():\\n     2\\t    pass\\n","message":"ok","display":[]}}}}';
    const parsed = JSON.parse(line);
    expect(parsed.params.type).toBe("ToolResult");
    const output = parsed.params.payload.return_value.output;
    expect(output).toContain("\t");
    expect(output).toContain("\n");
  });
});

// ── TS wire output verification ─────────────────────────────
// These tests verify that wireMsg() + createEventMessage() produces
// output that Harbor's _parse_wire_events can consume.

import { createEventMessage } from "../../src/kimi_cli_ts/wire/jsonrpc.ts";
import { wireMsg } from "../../src/kimi_cli_ts/soul/index.ts";

describe("Harbor wire — TS createEventMessage output", () => {
  test("TextPart text event maps to ContentPart on wire", () => {
    const msg = wireMsg("TextPart", { type: "text", text: "Hello" });
    const jsonrpc = createEventMessage(msg as any);
    const reparsed = JSON.parse(JSON.stringify(jsonrpc));

    expect(reparsed.jsonrpc).toBe("2.0");
    expect(reparsed.method).toBe("event");
    expect(reparsed.params.type).toBe("ContentPart");
    expect(reparsed.params.payload.type).toBe("text");
    expect(reparsed.params.payload.text).toBe("Hello");
  });

  test("ThinkPart think event matches Harbor format", () => {
    const msg = wireMsg("ThinkPart", { type: "think", think: "thinking...", encrypted: null });
    const params = JSON.parse(JSON.stringify(createEventMessage(msg as any))).params;
    expect(params.type).toBe("ContentPart");
    expect(params.payload.type).toBe("think");
  });

  test("ToolCall event matches Harbor nested function format", () => {
    const msg = wireMsg("ToolCall", {
      type: "function",
      id: "ReadFile:0",
      function: { name: "ReadFile", arguments: "" },
      extras: null,
    });
    const params = JSON.parse(JSON.stringify(createEventMessage(msg as any))).params;
    expect(params.type).toBe("ToolCall");
    expect(params.payload.type).toBe("function");
    expect(params.payload.id).toBe("ReadFile:0");
    expect(params.payload.function.name).toBe("ReadFile");
    expect(params.payload.function.arguments).toBe("");
    expect(params.payload.extras).toBeNull();
  });

  test("StatusUpdate token_usage uses Harbor field names", () => {
    const msg = wireMsg("StatusUpdate", {
      context_usage: 0.046,
      token_usage: { input_other: 1247, output: 8, input_cache_read: 4864, input_cache_creation: 0 },
      message_id: null,
    });
    const params = JSON.parse(JSON.stringify(createEventMessage(msg as any))).params;
    expect(params.type).toBe("StatusUpdate");
    const tu = params.payload.token_usage;
    expect(tu.input_other).toBe(1247);
    expect(tu.output).toBe(8);
    expect(tu.input_cache_read).toBe(4864);
    expect(tu.inputTokens).toBeUndefined();
  });

  test("ToolResult uses is_error and includes display/extras in return_value", () => {
    const msg = wireMsg("ToolResult", {
      tool_call_id: "ReadFile:0",
      return_value: { is_error: false, output: "hello\n", message: "ok", display: [], extras: null },
    });
    const params = JSON.parse(JSON.stringify(createEventMessage(msg as any))).params;
    expect(params.type).toBe("ToolResult");
    const rv = params.payload.return_value;
    expect(rv.is_error).toBe(false);
    expect(rv.display).toEqual([]);
    expect(rv.extras).toBeNull();
    expect(rv.isError).toBeUndefined();
  });

  test("TurnBegin/TurnEnd/StepBegin pass through correctly", () => {
    const b = JSON.parse(JSON.stringify(createEventMessage(wireMsg("TurnBegin", { user_input: "test" }) as any)));
    const s = JSON.parse(JSON.stringify(createEventMessage(wireMsg("StepBegin", { n: 1 }) as any)));
    const e = JSON.parse(JSON.stringify(createEventMessage(wireMsg("TurnEnd") as any)));
    expect(b.params.type).toBe("TurnBegin");
    expect(s.params.type).toBe("StepBegin");
    expect(e.params.type).toBe("TurnEnd");
  });
});
