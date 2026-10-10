import type { Request } from "express";
import { describe, expect, it } from "vitest";
import { isAllowedOrigin, readCookie } from "./middleware.js";

const allowed = ["http://dashboard.local.test", "https://dash.example.com"];

describe("isAllowedOrigin (CSRF check for cookie-authenticated requests)", () => {
  it.each([
    ["GET", undefined, true],
    ["HEAD", "http://evil.test", true],
    ["OPTIONS", undefined, true],
    ["POST", "http://dashboard.local.test", true],
    ["patch", "https://dash.example.com", true],
    ["DELETE", "https://dash.example.com", true],
    ["POST", undefined, false], // fail closed
    ["POST", "null", false], // sandboxed iframe / file://
    ["POST", "http://evil.test", false],
    ["POST", "https://dashboard.local.test", false], // scheme matters
    ["POST", "http://dashboard.local.test:8080", false], // port matters
    ["POST", "http://dashboard.local.test.evil.test", false], // no prefix matching
    ["PUT", "http://DASHBOARD.local.test", false], // browsers send lowercase; exact match only
  ])("%s with Origin %j -> %s", (method, origin, expected) => {
    expect(isAllowedOrigin(method, origin, allowed)).toBe(expected);
  });

  it("rejects every change when no origin is configured", () => {
    expect(isAllowedOrigin("POST", "http://dashboard.local.test", [])).toBe(false);
  });
});

describe("readCookie", () => {
  const req = (cookie?: string) => ({ headers: { cookie } }) as Request;
  it.each([
    [undefined, undefined],
    ["", undefined],
    ["mgw_session=abc", "abc"],
    ["a=1; mgw_session=abc; b=2", "abc"],
    ["  mgw_session = abc ", "abc"],
    ["xmgw_session=abc", undefined],
    ["mgw_session_old=abc", undefined],
    ["mgw_session=", ""],
    ["mgw_session=a=b", "a=b"],
  ])("%j -> %j", (header, expected) => {
    expect(readCookie(req(header), "mgw_session")).toBe(expected);
  });
});
