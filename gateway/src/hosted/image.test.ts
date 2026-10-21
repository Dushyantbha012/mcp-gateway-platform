import { describe, expect, it } from "vitest";
import { checkImage, ImageNotAllowedError, parseImage, qualifyRepository } from "./image.js";

describe("qualifyRepository", () => {
  it.each([
    ["redis", "docker.io/library/redis"],
    ["mcp/time", "docker.io/mcp/time"],
    ["docker.io/mcp/time", "docker.io/mcp/time"],
    ["ghcr.io/acme/server", "ghcr.io/acme/server"],
    ["localhost/x", "localhost/x"],
    ["registry:5000/x/y", "registry:5000/x/y"],
  ])("%s -> %s", (name, qualified) => {
    expect(qualifyRepository(name)).toBe(qualified);
  });
});

describe("parseImage", () => {
  it("splits tag and digest", () => {
    const digest = "sha256:" + "a".repeat(64);
    expect(parseImage(`mcp/time:1.0@${digest}`)).toEqual({
      repository: "docker.io/mcp/time",
      tag: "1.0",
      digest,
    });
    expect(parseImage("ghcr.io/a/b:v2")).toEqual({ repository: "ghcr.io/a/b", tag: "v2" });
  });

  it.each(["", "Mcp/Time:1", "mcp/time:", "a b:1", "mcp//time:1", "mcp/time:1;rm -rf"])(
    "rejects %j",
    (ref) => {
      expect(() => parseImage(ref)).toThrow(ImageNotAllowedError);
    },
  );
});

describe("checkImage", () => {
  const allowlist = ["docker.io/mcp/", "ghcr.io/acme/server"];

  it("allows pinned images under an allowlisted prefix, however they're spelled", () => {
    expect(checkImage("mcp/sequentialthinking:0.6.2", allowlist).repository).toBe(
      "docker.io/mcp/sequentialthinking",
    );
    expect(() => checkImage("docker.io/mcp/time:1", allowlist)).not.toThrow();
    expect(() => checkImage("ghcr.io/acme/server:1", allowlist)).not.toThrow();
    expect(() => checkImage(`mcp/time@sha256:${"b".repeat(64)}`, allowlist)).not.toThrow();
  });

  it("refuses images outside the allowlist, including look-alike names", () => {
    for (const ref of [
      "evil/mcp:1",
      "ghcr.io/acme/server-evil:1",
      "ghcr.io/acme/serverx:1",
      "docker.io/mcpx/time:1",
      "ghcr.io/mcp/time:1",
      "redis:7",
    ]) {
      expect(() => checkImage(ref, allowlist), ref).toThrow(/not in the image allowlist/);
    }
  });

  it("refuses :latest and unpinned images", () => {
    expect(() => checkImage("mcp/time:latest", allowlist)).toThrow(/latest/);
    expect(() => checkImage("mcp/time", allowlist)).toThrow(/pin the image/);
  });

  it("refuses everything when the allowlist is empty", () => {
    expect(() => checkImage("mcp/time:1", [])).toThrow(/no images are allowlisted/);
  });

  it("qualifies short allowlist entries too", () => {
    expect(() => checkImage("docker.io/mcp/time:1", ["mcp/"])).not.toThrow();
  });
});
