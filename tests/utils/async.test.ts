/**
 * Tests for utils/async.ts — async utilities.
 */
import { test, expect, describe } from "bun:test";
import {
  sleep,
  withTimeout,
  TimeoutError,
  Deferred,
  mapConcurrent,
} from "../../src/kimi_cli_ts/utils/async.ts";

describe("sleep", () => {
  test("resolves after delay", async () => {
    const t0 = performance.now();
    await sleep(50);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(40); // allow slight imprecision
  });
});

describe("withTimeout", () => {
  test("resolves when function completes within timeout", async () => {
    const result = await withTimeout(async () => 42, 1000);
    expect(result).toBe(42);
  });

  test("rejects with TimeoutError when exceeding timeout", async () => {
    await expect(
      withTimeout(() => sleep(500).then(() => 42), 50),
    ).rejects.toThrow(TimeoutError);
  });

  test("TimeoutError has correct name", () => {
    const err = new TimeoutError("test");
    expect(err.name).toBe("TimeoutError");
    expect(err.message).toBe("test");
  });
});

describe("Deferred", () => {
  test("resolves externally", async () => {
    const d = new Deferred<number>();
    expect(d.settled).toBe(false);
    d.resolve(42);
    const value = await d.promise;
    expect(value).toBe(42);
    expect(d.settled).toBe(true);
  });

  test("rejects externally", async () => {
    const d = new Deferred<number>();
    d.reject(new Error("fail"));
    await expect(d.promise).rejects.toThrow("fail");
    expect(d.settled).toBe(true);
  });

  test("double resolve is ignored", async () => {
    const d = new Deferred<number>();
    d.resolve(1);
    d.resolve(2); // should be ignored
    const value = await d.promise;
    expect(value).toBe(1);
  });

  test("double reject is ignored", async () => {
    const d = new Deferred<number>();
    d.reject(new Error("first"));
    d.reject(new Error("second")); // should be ignored
    await expect(d.promise).rejects.toThrow("first");
  });

  test("resolve after reject is ignored", async () => {
    const d = new Deferred<number>();
    d.reject(new Error("fail"));
    d.resolve(42); // should be ignored
    await expect(d.promise).rejects.toThrow("fail");
  });
});

describe("mapConcurrent", () => {
  test("processes all items", async () => {
    const items = [1, 2, 3, 4, 5];
    const results = await mapConcurrent(items, 2, async (x) => x * 2);
    expect(results).toEqual([2, 4, 6, 8, 10]);
  });

  test("respects concurrency limit", async () => {
    let active = 0;
    let maxActive = 0;
    const items = [1, 2, 3, 4, 5];

    await mapConcurrent(items, 2, async (x) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await sleep(10);
      active--;
      return x;
    });

    expect(maxActive).toBeLessThanOrEqual(2);
  });

  test("empty items returns empty array", async () => {
    const results = await mapConcurrent([], 4, async (x) => x);
    expect(results).toEqual([]);
  });

  test("single item works", async () => {
    const results = await mapConcurrent([42], 1, async (x) => x * 2);
    expect(results).toEqual([84]);
  });
});
