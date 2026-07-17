/**
 * Tests for ui/shell/events.ts — event type definitions.
 */

import { test, expect, describe } from "bun:test";
import type {
  UIMessageRole,
  TextSegment,
  ThinkSegment,
  ToolCallSegment,
  MessageSegment,
  UIMessage,
  WireUIEvent,
} from "../../src/kimi_cli_ts/ui/shell/events";

describe("event types", () => {
  test("UIMessageRole accepts valid roles", () => {
    const roles: UIMessageRole[] = ["user", "assistant", "system", "tool"];
    expect(roles).toHaveLength(4);
  });

  test("TextSegment structure", () => {
    const seg: TextSegment = { type: "text", text: "hello" };
    expect(seg.type).toBe("text");
    expect(seg.text).toBe("hello");
  });

  test("ThinkSegment structure", () => {
    const seg: ThinkSegment = { type: "think", text: "thinking..." };
    expect(seg.type).toBe("think");
  });

  test("ToolCallSegment structure", () => {
    const seg: ToolCallSegment = {
      type: "tool_call",
      id: "tc-1",
      name: "ReadFile",
      arguments: '{"path":"test.ts"}',
      collapsed: false,
    };
    expect(seg.type).toBe("tool_call");
    expect(seg.id).toBe("tc-1");
    expect(seg.name).toBe("ReadFile");
  });

  test("UIMessage structure", () => {
    const msg: UIMessage = {
      id: "msg-1",
      role: "assistant",
      segments: [{ type: "text", text: "hello" }],
      timestamp: Date.now(),
    };
    expect(msg.role).toBe("assistant");
    expect(msg.segments).toHaveLength(1);
  });

  test("WireUIEvent union covers expected types", () => {
    const events: WireUIEvent[] = [
      { type: "turn_begin", userInput: "hi" },
      { type: "turn_end" },
      { type: "text_delta", text: "hello" },
      { type: "think_delta", text: "hmm" },
      { type: "error", message: "oops" },
    ];
    expect(events).toHaveLength(5);
    expect(events[0].type).toBe("turn_begin");
    expect(events[4].type).toBe("error");
  });
});
