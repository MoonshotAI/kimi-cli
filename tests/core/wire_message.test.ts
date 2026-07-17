/**
 * Tests for wire/types.ts + wire/serde.ts — wire message system.
 */
import { test, expect, describe } from "bun:test";
import {
  TurnBegin,
  StepBegin,
  StatusUpdate,
  HookTriggered,
  HookResolved,
  ApprovalRequest,
  ApprovalResponse,
  BriefDisplayBlock,
  DiffDisplayBlock,
  toEnvelope,
  fromEnvelope,
  isEventTypeName,
  isRequestTypeName,
  getWireMessageSchema,
} from "../../src/kimi_cli_ts/wire/types.ts";
import {
  serializeWireMessage,
  deserializeWireMessage,
  serializeWireMessageToJSON,
  deserializeWireMessageFromJSON,
} from "../../src/kimi_cli_ts/wire/serde.ts";

describe("Wire Event Zod Parsing", () => {
  test("TurnBegin parses string input", () => {
    const msg = TurnBegin.parse({ user_input: "hello" });
    expect(msg.user_input).toBe("hello");
  });

  test("TurnBegin parses content part array", () => {
    const msg = TurnBegin.parse({
      user_input: [{ type: "text", text: "hello" }],
    });
    expect(Array.isArray(msg.user_input)).toBe(true);
  });

  test("StepBegin parses step number", () => {
    const msg = StepBegin.parse({ n: 3 });
    expect(msg.n).toBe(3);
  });

  test("StatusUpdate parses with defaults", () => {
    const msg = StatusUpdate.parse({});
    expect(msg.context_usage).toBeNull();
    expect(msg.context_tokens).toBeNull();
    expect(msg.plan_mode).toBeNull();
  });

  test("StatusUpdate parses with values", () => {
    const msg = StatusUpdate.parse({
      context_usage: 0.5,
      context_tokens: 5000,
      max_context_tokens: 10000,
      plan_mode: true,
    });
    expect(msg.context_usage).toBe(0.5);
    expect(msg.plan_mode).toBe(true);
  });

  test("HookTriggered parses with defaults", () => {
    const msg = HookTriggered.parse({ event: "PreToolUse" });
    expect(msg.event).toBe("PreToolUse");
    expect(msg.target).toBe("");
    expect(msg.hook_count).toBe(1);
  });

  test("HookResolved parses with values", () => {
    const msg = HookResolved.parse({
      event: "PreToolUse",
      target: "shell",
      action: "block",
      reason: "not allowed",
      duration_ms: 123,
    });
    expect(msg.action).toBe("block");
    expect(msg.reason).toBe("not allowed");
  });

  test("ApprovalRequest parses", () => {
    const msg = ApprovalRequest.parse({
      id: "req-1",
      tool_call_id: "tc-1",
      sender: "user",
      action: "shell",
      description: "Run ls",
    });
    expect(msg.id).toBe("req-1");
    expect(msg.source_kind).toBeNull();
    expect(msg.display).toEqual([]);
  });

  test("ApprovalResponse parses", () => {
    const msg = ApprovalResponse.parse({
      request_id: "req-1",
      response: "approve",
    });
    expect(msg.response).toBe("approve");
    expect(msg.feedback).toBe("");
  });
});

describe("Display Blocks", () => {
  test("BriefDisplayBlock", () => {
    const block = BriefDisplayBlock.parse({ type: "brief", brief: "hello" });
    expect(block.brief).toBe("hello");
  });

  test("DiffDisplayBlock with defaults", () => {
    const block = DiffDisplayBlock.parse({
      type: "diff",
      path: "test.ts",
      old_text: "a",
      new_text: "b",
    });
    expect(block.old_start).toBe(1);
    expect(block.new_start).toBe(1);
    expect(block.is_summary).toBe(false);
  });
});

describe("Envelope serialization", () => {
  test("toEnvelope creates correct structure", () => {
    const env = toEnvelope("TurnBegin", { user_input: "test" });
    expect(env.type).toBe("TurnBegin");
    expect(env.payload.user_input).toBe("test");
  });

  test("fromEnvelope validates and returns parsed message", () => {
    const env = toEnvelope("StepBegin", { n: 5 });
    const { typeName, message } = fromEnvelope(env);
    expect(typeName).toBe("StepBegin");
    expect((message as any).n).toBe(5);
  });

  test("fromEnvelope throws for unknown type", () => {
    const env = { type: "NonexistentType", payload: {} };
    expect(() => fromEnvelope(env)).toThrow("Unknown wire message type");
  });
});

describe("Wire serde", () => {
  test("serializeWireMessage creates envelope object", () => {
    const obj = serializeWireMessage("TurnBegin", { user_input: "hi" });
    expect(obj.type).toBe("TurnBegin");
    expect((obj.payload as any).user_input).toBe("hi");
  });

  test("deserializeWireMessage round-trips", () => {
    const serialized = serializeWireMessage("StepBegin", { n: 3 });
    const { typeName, message } = deserializeWireMessage(serialized);
    expect(typeName).toBe("StepBegin");
    expect((message as any).n).toBe(3);
  });

  test("JSON string round-trip", () => {
    const json = serializeWireMessageToJSON("HookTriggered", {
      event: "PreToolUse",
      target: "shell",
      hook_count: 2,
    });
    const { typeName, message } = deserializeWireMessageFromJSON(json);
    expect(typeName).toBe("HookTriggered");
    expect((message as any).event).toBe("PreToolUse");
    expect((message as any).hook_count).toBe(2);
  });

  test("deserializeWireMessage throws for malformed data", () => {
    expect(() => deserializeWireMessage("not json")).toThrow();
  });
});

describe("Type name helpers", () => {
  test("isEventTypeName identifies events", () => {
    expect(isEventTypeName("TurnBegin")).toBe(true);
    expect(isEventTypeName("StatusUpdate")).toBe(true);
    expect(isEventTypeName("ToolResult")).toBe(true);
    expect(isEventTypeName("ApprovalRequest")).toBe(false);
  });

  test("isRequestTypeName identifies requests", () => {
    expect(isRequestTypeName("ApprovalRequest")).toBe(true);
    expect(isRequestTypeName("QuestionRequest")).toBe(true);
    expect(isRequestTypeName("HookRequest")).toBe(true);
    expect(isRequestTypeName("TurnBegin")).toBe(false);
  });

  test("getWireMessageSchema returns schema for known type", () => {
    expect(getWireMessageSchema("TurnBegin")).toBeDefined();
    expect(getWireMessageSchema("StatusUpdate")).toBeDefined();
  });

  test("getWireMessageSchema returns undefined for unknown type", () => {
    expect(getWireMessageSchema("NonexistentType")).toBeUndefined();
  });
});
