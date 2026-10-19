import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { log } from "./logger.js";
import {
  currentRequestId,
  REQUEST_ID_HEADER,
  requestId,
  runWithRequestId,
} from "./requestContext.js";

function appWithRequestId() {
  const app = express();
  app.use(requestId());
  app.get("/", (_req, res) => {
    res.json({ seen: currentRequestId(), local: res.locals.requestId });
  });
  return app;
}

describe("request ID middleware", () => {
  it("generates an ID, returns it in the header, and exposes it to handlers", async () => {
    const res = await request(appWithRequestId()).get("/");
    const id = res.headers[REQUEST_ID_HEADER.toLowerCase()];
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body).toEqual({ seen: id, local: id });
  });

  it("keeps a well-formed ID from the caller", async () => {
    const res = await request(appWithRequestId())
      .get("/")
      .set(REQUEST_ID_HEADER, "trace-abc.123_XYZ");
    expect(res.headers[REQUEST_ID_HEADER.toLowerCase()]).toBe("trace-abc.123_XYZ");
    expect(res.body.seen).toBe("trace-abc.123_XYZ");
  });

  it.each([
    ["short"],
    ["has spaces in it"],
    ["x".repeat(129)],
    ['quote"injection{'],
    ["a\tb-cdefgh"],
  ])("replaces a malformed ID from the caller (%j)", async (bad) => {
    const res = await request(appWithRequestId()).get("/").set(REQUEST_ID_HEADER, bad);
    const id = res.headers[REQUEST_ID_HEADER.toLowerCase()];
    expect(id).not.toBe(bad);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("gives concurrent requests their own IDs", async () => {
    const app = appWithRequestId();
    const ids = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(app)
          .get("/")
          .then((r) => r.body.seen as string),
      ),
    );
    expect(new Set(ids).size).toBe(5);
  });
});

describe("logger", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("adds the current request ID to every line, and leaves it out elsewhere", () => {
    vi.stubEnv("NODE_ENV", "production");
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    runWithRequestId("req-12345678", () => log("info", "inside"));
    log("info", "outside");
    const [inside, outside] = out.mock.calls.map((c) => JSON.parse(String(c[0])));
    expect(inside).toMatchObject({ msg: "inside", requestId: "req-12345678" });
    expect(outside.msg).toBe("outside");
    expect(outside).not.toHaveProperty("requestId");
  });
});
