/**
 * Real LLM E2E tests — corresponds to Python tests_e2e/test_wire_real_llm.py
 * All skipped: require real LLM credentials.
 */

import { describe, it } from "bun:test";

describe("wire real LLM", () => {
  it.skip("basic prompt with real LLM", () => {});
  it.skip("tool call with real LLM", () => {});
  it.skip("multi-turn with real LLM", () => {});
  it.skip("streaming with real LLM", () => {});
});
