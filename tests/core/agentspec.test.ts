/**
 * Tests for agentspec.ts — agent specification loading.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import {
  loadAgentSpec,
  AgentSpecError,
} from "../../src/kimi_cli_ts/agentspec.ts";
import { createTempDir, removeTempDir } from "../conftest.ts";

describe("AgentSpec", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  test("loadAgentSpec throws for missing file", async () => {
    await expect(
      loadAgentSpec(join(tempDir, "nonexistent.yaml")),
    ).rejects.toThrow(AgentSpecError);
  });

  test("loadAgentSpec throws for unsupported version", async () => {
    const agentFile = join(tempDir, "agent.yaml");
    await Bun.write(
      agentFile,
      `version: "99"\nagent:\n  name: test\n  system_prompt_path: prompt.md\n  tools:\n    - shell\n`,
    );
    await expect(loadAgentSpec(agentFile)).rejects.toThrow("Unsupported agent spec version");
  });

  test("loadAgentSpec loads simple agent", async () => {
    const agentFile = join(tempDir, "agent.yaml");
    const promptFile = join(tempDir, "prompt.md");
    await Bun.write(promptFile, "You are a helpful assistant.");
    await Bun.write(
      agentFile,
      [
        "version: 1",
        "agent:",
        "  name: test-agent",
        `  system_prompt_path: prompt.md`,
        "  tools:",
        "    - shell",
        "    - read",
      ].join("\n"),
    );

    const spec = await loadAgentSpec(agentFile);
    expect(spec.name).toBe("test-agent");
    expect(spec.systemPromptPath).toContain("prompt.md");
    expect(spec.tools).toEqual(["shell", "read"]);
  });

  test("loadAgentSpec resolves relative system_prompt_path", async () => {
    const subDir = join(tempDir, "sub");
    await Bun.$`mkdir -p ${subDir}`.quiet();
    const agentFile = join(subDir, "agent.yaml");
    const promptFile = join(subDir, "prompt.md");
    await Bun.write(promptFile, "prompt");
    await Bun.write(
      agentFile,
      [
        "version: 1",
        "agent:",
        "  name: sub-agent",
        "  system_prompt_path: prompt.md",
        "  tools:",
        "    - shell",
      ].join("\n"),
    );

    const spec = await loadAgentSpec(agentFile);
    expect(spec.systemPromptPath).toBe(join(subDir, "prompt.md"));
  });

  test("loadAgentSpec requires name", async () => {
    const agentFile = join(tempDir, "agent.yaml");
    await Bun.write(
      agentFile,
      [
        "version: 1",
        "agent:",
        "  system_prompt_path: prompt.md",
        "  tools:",
        "    - shell",
      ].join("\n"),
    );
    await expect(loadAgentSpec(agentFile)).rejects.toThrow("Agent name is required");
  });

  test("loadAgentSpec handles model and whenToUse", async () => {
    const agentFile = join(tempDir, "agent.yaml");
    await Bun.write(
      agentFile,
      [
        "version: 1",
        "agent:",
        "  name: custom",
        "  system_prompt_path: prompt.md",
        "  model: gpt-4",
        "  when_to_use: For complex tasks",
        "  tools:",
        "    - shell",
      ].join("\n"),
    );

    const spec = await loadAgentSpec(agentFile);
    expect(spec.model).toBe("gpt-4");
    expect(spec.whenToUse).toBe("For complex tasks");
  });
});
