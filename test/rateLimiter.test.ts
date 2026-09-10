import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { checkRateLimit } from "../infra/lambda/rateLimiter.js";

describe("checkRateLimit", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows the first 10 requests from a given IP within the window", () => {
    const ip = "1.1.1.1";
    for (let i = 0; i < 10; i++) {
      const result = checkRateLimit(ip);
      expect(result.allowed).toBe(true);
    }
  });

  it("blocks the 11th request within the same window", () => {
    const ip = "2.2.2.2";
    for (let i = 0; i < 10; i++) checkRateLimit(ip);
    const result = checkRateLimit(ip);
    expect(result.allowed).toBe(false);
    expect(result.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("tracks separate IPs independently", () => {
    const ipA = "3.3.3.3";
    const ipB = "4.4.4.4";
    for (let i = 0; i < 10; i++) checkRateLimit(ipA);
    expect(checkRateLimit(ipA).allowed).toBe(false);
    expect(checkRateLimit(ipB).allowed).toBe(true);
  });

  it("resets the count after the window elapses", () => {
    const ip = "5.5.5.5";
    for (let i = 0; i < 10; i++) checkRateLimit(ip);
    expect(checkRateLimit(ip).allowed).toBe(false);

    vi.advanceTimersByTime(61_000);
    expect(checkRateLimit(ip).allowed).toBe(true);
  });
});
