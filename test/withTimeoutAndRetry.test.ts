import { describe, it, expect, vi } from "vitest";
import { withTimeoutAndRetry, ToolTimeoutError } from "../src/lib/withTimeoutAndRetry.js";

// Fault-injection tests for the actual retry/timeout primitive underneath
// every tool call in the orchestrator. These deliberately inject failures
// (a function that hangs forever, a function that throws N times before
// succeeding, a function that always throws) rather than asserting on a
// single hardcoded mock — the goal is to prove the bounded-retry contract
// holds under a range of failure shapes, not just the one the orchestrator
// happens to exercise elsewhere.

describe("withTimeoutAndRetry — fault injection", () => {
  it("propagates a successful result on the first attempt with no retries wasted", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withTimeoutAndRetry(fn, { timeoutMs: 100, maxRetries: 2, toolName: "test" });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("times out a function that never resolves, and throws ToolTimeoutError", async () => {
    const hangs = () => new Promise<string>(() => {}); // never resolves
    await expect(
      withTimeoutAndRetry(hangs, { timeoutMs: 20, maxRetries: 0, toolName: "hanging_tool" }),
    ).rejects.toThrow(ToolTimeoutError);
  });

  it("retries exactly maxRetries+1 times total before giving up on a tool that always fails", async () => {
    const alwaysFails = vi.fn().mockRejectedValue(new Error("persistent failure"));
    await expect(
      withTimeoutAndRetry(alwaysFails, { timeoutMs: 100, maxRetries: 3, toolName: "flaky" }),
    ).rejects.toThrow("persistent failure");
    expect(alwaysFails).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
  });

  it("recovers from a tool that fails N times then succeeds, as long as N <= maxRetries", async () => {
    let callCount = 0;
    const flakyThenRecovers = vi.fn().mockImplementation(async () => {
      callCount += 1;
      if (callCount <= 2) throw new Error(`transient failure ${callCount}`);
      return "recovered";
    });
    const result = await withTimeoutAndRetry(flakyThenRecovers, {
      timeoutMs: 100,
      maxRetries: 2,
      toolName: "eventually_ok",
    });
    expect(result).toBe("recovered");
    expect(flakyThenRecovers).toHaveBeenCalledTimes(3);
  });

  it("fails permanently if the tool needs more attempts than maxRetries allows", async () => {
    let callCount = 0;
    const tooFlaky = vi.fn().mockImplementation(async () => {
      callCount += 1;
      if (callCount <= 3) throw new Error(`transient failure ${callCount}`);
      return "recovered too late";
    });
    await expect(
      withTimeoutAndRetry(tooFlaky, { timeoutMs: 100, maxRetries: 1, toolName: "too_flaky" }),
    ).rejects.toThrow("transient failure 2");
    expect(tooFlaky).toHaveBeenCalledTimes(2); // 1 initial + 1 retry, both fail
  });

  it("throws the LAST error, not the first, when multiple different errors occur across retries", async () => {
    let callCount = 0;
    const differentErrorsEachTime = vi.fn().mockImplementation(async () => {
      callCount += 1;
      throw new Error(`failure variant ${callCount}`);
    });
    await expect(
      withTimeoutAndRetry(differentErrorsEachTime, { timeoutMs: 100, maxRetries: 2, toolName: "varied" }),
    ).rejects.toThrow("failure variant 3");
  });

  it("a slow-but-eventually-successful call within the timeout is not treated as a failure", async () => {
    const slowButOk = () =>
      new Promise<string>((resolve) => setTimeout(() => resolve("slow ok"), 30));
    const result = await withTimeoutAndRetry(slowButOk, {
      timeoutMs: 200,
      maxRetries: 0,
      toolName: "slow_tool",
    });
    expect(result).toBe("slow ok");
  });

  it("a call that resolves just after its own timeout is still treated as timed out, not silently accepted late", async () => {
    let resolveLate: (v: string) => void;
    const resolvesAfterTimeout = () =>
      new Promise<string>((resolve) => {
        resolveLate = resolve;
        setTimeout(() => resolve("too late"), 500);
      });
    await expect(
      withTimeoutAndRetry(resolvesAfterTimeout, { timeoutMs: 20, maxRetries: 0, toolName: "late" }),
    ).rejects.toThrow(ToolTimeoutError);
  });
});
