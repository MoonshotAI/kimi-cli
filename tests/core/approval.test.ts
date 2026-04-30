/**
 * Tests for soul/approval.ts — approval system.
 */
import { test, expect, describe, beforeEach } from "bun:test";
import {
  Approval,
  ApprovalResult,
  ApprovalState,
} from "../../src/kimi_cli_ts/soul/approval.ts";
import { ApprovalRuntime } from "../../src/kimi_cli_ts/approval_runtime/index.ts";

describe("ApprovalResult", () => {
  test("approved result", () => {
    const r = new ApprovalResult(true);
    expect(r.approved).toBe(true);
    expect(r.feedback).toBe("");
    expect(r.valueOf()).toBe(true);
  });

  test("rejected result with feedback", () => {
    const r = new ApprovalResult(false, "not allowed");
    expect(r.approved).toBe(false);
    expect(r.feedback).toBe("not allowed");
    expect(r.valueOf()).toBe(false);
  });
});

describe("ApprovalState", () => {
  test("default state", () => {
    const state = new ApprovalState();
    expect(state.yolo).toBe(false);
    expect(state.autoApproveActions.size).toBe(0);
  });

  test("yolo mode", () => {
    const state = new ApprovalState({ yolo: true });
    expect(state.yolo).toBe(true);
  });

  test("onChange callback fires", () => {
    let changed = false;
    const state = new ApprovalState({ onChange: () => { changed = true; } });
    state.notifyChange();
    expect(changed).toBe(true);
  });
});

describe("Approval", () => {
  test("yolo mode auto-approves", async () => {
    const approval = new Approval({ yolo: true });
    const result = await approval.request("test", "shell", "run ls");
    expect(result.approved).toBe(true);
  });

  test("isYolo and setYolo work", () => {
    const approval = new Approval({ yolo: false });
    expect(approval.isYolo()).toBe(false);
    approval.setYolo(true);
    expect(approval.isYolo()).toBe(true);
  });

  test("auto-approve actions bypass approval", async () => {
    const state = new ApprovalState({
      autoApproveActions: new Set(["shell"]),
    });
    const approval = new Approval({ state });
    const result = await approval.request("test", "shell", "run ls");
    expect(result.approved).toBe(true);
  });

  test("request goes through runtime when not yolo and not auto-approved", async () => {
    const runtime = new ApprovalRuntime();
    const approval = new Approval({ yolo: false, runtime });

    // Start request in background
    const requestPromise = approval.request("test", "shell", "run ls");

    // Find and resolve the pending request
    const pending = runtime.listPending();
    expect(pending.length).toBe(1);
    expect(pending[0]!.action).toBe("shell");

    runtime.resolve(pending[0]!.id, "approve");
    const result = await requestPromise;
    expect(result.approved).toBe(true);
  });

  test("reject returns false with feedback", async () => {
    const runtime = new ApprovalRuntime();
    const approval = new Approval({ yolo: false, runtime });

    const requestPromise = approval.request("test", "shell", "dangerous cmd");

    const pending = runtime.listPending();
    runtime.resolve(pending[0]!.id, "reject", "too dangerous");

    const result = await requestPromise;
    expect(result.approved).toBe(false);
    expect(result.feedback).toBe("too dangerous");
  });

  test("approve_for_session adds to auto-approve actions", async () => {
    const runtime = new ApprovalRuntime();
    const approval = new Approval({ yolo: false, runtime });

    const requestPromise = approval.request("test", "shell", "run ls");

    const pending = runtime.listPending();
    runtime.resolve(pending[0]!.id, "approve_for_session");

    const result = await requestPromise;
    expect(result.approved).toBe(true);

    // Next request for same action should auto-approve
    const result2 = await approval.request("test", "shell", "run pwd");
    expect(result2.approved).toBe(true);
  });

  test("share creates approval with shared state", async () => {
    const approval = new Approval({ yolo: true });
    const shared = approval.share();
    expect(shared.isYolo()).toBe(true);

    approval.setYolo(false);
    expect(shared.isYolo()).toBe(false);
  });
});
