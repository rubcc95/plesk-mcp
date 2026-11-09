import { describe, expect, it } from "vitest";
import { AppError, PleskHttpError } from "./errors.js";
import { mapPool } from "./pool.js";
import { isRetryable, withRetry } from "./retry.js";

describe("mapPool", () => {
  it("preserves order and limits concurrency", async () => {
    let active = 0;
    let maxActive = 0;

    const result = await mapPool([1, 2, 3, 4, 5], 2, async (value) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return value * 2;
    });

    expect(result).toEqual([2, 4, 6, 8, 10]);
    expect(maxActive).toBeLessThanOrEqual(2);
  });
});

describe("withRetry", () => {
  it("retries transient errors until completion", async () => {
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts += 1;
        if (attempts < 3) {
          throw new AppError("PLESK_UNREACHABLE", "no connection");
        }
        return "ok";
      },
      { baseDelayMs: 1 }
    );

    expect(result).toBe("ok");
    expect(attempts).toBe(3);
  });

  it("does not retry permanent errors", async () => {
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts += 1;
          throw new PleskHttpError(404, "does not exist");
        },
        { baseDelayMs: 1 }
      )
    ).rejects.toThrow(/does not exist/);
    expect(attempts).toBe(1);
  });

  it("does not retry DNS or TLS", () => {
    expect(
      isRetryable(
        new AppError("PLESK_UNREACHABLE", "x", {
          cause: Object.assign(new Error("dns"), { code: "ENOTFOUND" })
        })
      )
    ).toBe(false);
  });

  it("classifies 5xx and network errors as retryable", () => {
    expect(isRetryable(new PleskHttpError(503, "unavailable"))).toBe(true);
    expect(isRetryable(new PleskHttpError(429, "too many"))).toBe(true);
    expect(isRetryable(new PleskHttpError(403, "forbidden"))).toBe(false);
    expect(isRetryable(new PleskHttpError(404, "missing"))).toBe(false);
    expect(isRetryable(new AppError("PLESK_DOWNLOAD_FAILED", "x"))).toBe(true);
    expect(isRetryable(new AppError("OTHER", "x"))).toBe(false);
  });
});
