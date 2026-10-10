import { describe, expect, it } from "vitest";
import { FailureLimiter } from "./rateLimit.js";

function limiter(max = 3, windowMs = 1_000, maxKeys?: number) {
  let now = 0;
  const l = new FailureLimiter({ max, windowMs, maxKeys, now: () => now });
  return { l, advance: (ms: number) => (now += ms) };
}

describe("FailureLimiter", () => {
  it("allows up to max failures, then blocks until the oldest leaves the window", () => {
    const { l, advance } = limiter(3, 1_000);
    for (let i = 0; i < 3; i++) {
      expect(l.retryAfterMs("ip")).toBe(0);
      l.recordFailure("ip");
      advance(100);
    }
    // Failures at t=0,100,200; now t=300.
    expect(l.retryAfterMs("ip")).toBe(700);
    advance(699);
    expect(l.retryAfterMs("ip")).toBe(1);
    advance(1);
    expect(l.retryAfterMs("ip")).toBe(0);
  });

  it("keeps keys independent and forgets a key on reset", () => {
    const { l } = limiter(1);
    l.recordFailure("email:a");
    expect(l.retryAfterMs("email:a")).toBeGreaterThan(0);
    expect(l.retryAfterMs("email:b")).toBe(0);
    l.reset("email:a");
    expect(l.retryAfterMs("email:a")).toBe(0);
  });

  it("bounds memory by evicting the least recently failed key", () => {
    const { l } = limiter(1, 1_000, 2);
    l.recordFailure("a");
    l.recordFailure("b");
    l.recordFailure("a"); // a is now the most recent
    l.recordFailure("c"); // evicts b
    expect(l.retryAfterMs("a")).toBeGreaterThan(0);
    expect(l.retryAfterMs("b")).toBe(0);
    expect(l.retryAfterMs("c")).toBeGreaterThan(0);
  });
});
