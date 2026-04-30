/**
 * Tests for session.ts — session management.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import {
  Session,
  SessionState,
  loadSessionState,
  saveSessionState,
} from "../../src/kimi_cli_ts/session.ts";
import { createTempDir, removeTempDir, createTestSession } from "../conftest.ts";

describe("SessionState", () => {
  test("default session state", () => {
    const state = SessionState.parse({});
    expect(state.version).toBe(1);
    // zod/v4 with default({} as any) does not fill nested defaults
    expect(state.approval).toEqual({});
    expect(state.additional_dirs).toEqual([]);
    expect(state.custom_title).toBeNull();
    expect(state.plan_mode).toBe(false);
    expect(state.archived).toBe(false);
  });

  test("parse with values", () => {
    const state = SessionState.parse({
      approval: { yolo: true, auto_approve_actions: ["shell"] },
      plan_mode: true,
      custom_title: "My Session",
    });
    expect(state.approval.yolo).toBe(true);
    expect(state.approval.auto_approve_actions).toEqual(["shell"]);
    expect(state.plan_mode).toBe(true);
    expect(state.custom_title).toBe("My Session");
  });
});

describe("Session State Persistence", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  test("saveSessionState and loadSessionState roundtrip", async () => {
    const state = SessionState.parse({
      approval: { yolo: true },
      custom_title: "Test",
    });
    await saveSessionState(state, tempDir);
    const loaded = await loadSessionState(tempDir);
    expect(loaded.approval.yolo).toBe(true);
    expect(loaded.custom_title).toBe("Test");
  });

  test("loadSessionState returns defaults for missing file", async () => {
    const state = await loadSessionState(join(tempDir, "nonexistent"));
    expect(state.version).toBe(1);
    expect(state.approval).toEqual({});
  });
});

describe("Session", () => {
  let tempDir: string;
  let workDir: string;
  let shareDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
    workDir = join(tempDir, "work");
    shareDir = join(tempDir, "share");
    Bun.spawnSync(["mkdir", "-p", workDir, shareDir]);
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  test("createTestSession produces valid session", () => {
    const session = createTestSession(workDir, shareDir);
    expect(session.id).toBe("test-session");
    expect(session.title).toBe("Test Session");
  });

  test("Session.dir returns correct path", () => {
    const session = createTestSession(workDir, shareDir);
    expect(session.dir).toContain("test-session");
  });

  test("isEmpty returns true for empty context", async () => {
    const session = createTestSession(workDir, shareDir);
    const empty = await session.isEmpty();
    expect(empty).toBe(true);
  });

  test("isEmpty returns false when context has messages", async () => {
    const session = createTestSession(workDir, shareDir);
    // Write a user message to context file
    await Bun.write(
      session.contextFile,
      JSON.stringify({ role: "user", content: "hello" }) + "\n",
    );
    const empty = await session.isEmpty();
    expect(empty).toBe(false);
  });

  test("isEmpty returns false when custom_title is set", async () => {
    const session = createTestSession(workDir, shareDir);
    session.state.custom_title = "Custom Title";
    const empty = await session.isEmpty();
    expect(empty).toBe(false);
  });

  test("saveState persists state to file", async () => {
    const session = createTestSession(workDir, shareDir);
    session.state.approval.yolo = true;
    await session.saveState();

    const loaded = await loadSessionState(session.dir);
    expect(loaded.approval.yolo).toBe(true);
  });
});
