import { describe, expect, it } from "vitest";
import { hostedFixture } from "@/test/server";
import {
  hostedDefaults,
  hostedFormSchema,
  joinCommand,
  splitCommand,
  toHostedInput,
  toHostedUpdate,
  type HostedFormValues,
} from "./hostedForm";

const valid = (overrides: Partial<HostedFormValues> = {}): HostedFormValues => ({
  ...hostedDefaults(),
  slug: "thinking",
  name: "Thinking",
  image: "mcp/sequentialthinking:1.0",
  command: "node dist/index.js",
  ...overrides,
});
const issues = (v: HostedFormValues) =>
  hostedFormSchema.safeParse(v).error?.issues.map((i) => `${i.path.join(".")}: ${i.message}`) ?? [];

describe("splitCommand / joinCommand", () => {
  it("splits on whitespace and honours quotes, and round-trips", () => {
    expect(splitCommand("  node  dist/index.js --flag ")).toEqual([
      "node",
      "dist/index.js",
      "--flag",
    ]);
    expect(splitCommand(`python -c "print('hi there')" ''`)).toEqual([
      "python",
      "-c",
      "print('hi there')",
      "",
    ]);
    for (const args of [
      ["node", "my dir/x.js"],
      ["sh", "-c", 'echo "a b"'],
      ["x", ""],
    ]) {
      expect(splitCommand(joinCommand(args))).toEqual(args);
    }
  });
});

describe("hostedFormSchema", () => {
  it("accepts a minimal stdio server", () => {
    expect(issues(valid())).toEqual([]);
  });

  it("mirrors the gateway's checks", () => {
    expect(issues(valid({ command: "" }))).toEqual([
      "command: Required: the bridge runs it in place of the image's entrypoint",
    ]);
    expect(issues(valid({ command: 'node "x' }))).toEqual(["command: Unclosed quote"]);
    expect(issues(valid({ transport: "http", command: "" }))).toEqual([]);
    expect(issues(valid({ image: "mcp/x :1" }))).toEqual([
      "image: No spaces in an image reference",
    ]);
    expect(issues(valid({ transport: "http", path: "mcp" }))).toEqual([
      "path: A URL path starting with /",
    ]);
    const row = (name: string, value = "v", secret = false) => ({
      name,
      value,
      secret,
      stored: false,
    });
    expect(
      issues(
        valid({
          env: [row("BAD-NAME"), row("BRIDGE_X"), row("A"), row("A"), row("S", "", true)],
        }),
      ),
    ).toEqual([
      "env.0.name: Not a valid name",
      "env.1.name: BRIDGE_* is reserved",
      "env.3.name: Listed twice",
      "env.4.value: Required",
    ]);
    expect(
      issues(valid({ transport: "http", authTokenEnv: "TOKEN", env: [row("TOKEN")] })),
    ).toEqual(["env.0.name: Set by the provisioner (auth token)"]);
  });
});

describe("toHostedInput", () => {
  it("splits plain and secret variables, and drops http-only fields for stdio", () => {
    expect(
      toHostedInput(
        valid({
          port: 3000,
          authTokenEnv: "TOKEN",
          env: [
            { name: "LOG", value: "debug", secret: false, stored: false },
            { name: "KEY", value: "s3cret", secret: true, stored: false },
          ],
        }),
      ),
    ).toEqual({
      slug: "thinking",
      name: "Thinking",
      image: "mcp/sequentialthinking:1.0",
      transport: "stdio",
      command: ["node", "dist/index.js"],
      port: 8080,
      path: "/mcp",
      libc: "glibc",
      env: { LOG: "debug" },
      secretEnv: { KEY: "s3cret" },
      authTokenEnv: null,
      egress: "none",
      size: "small",
    });
  });
});

describe("toHostedUpdate", () => {
  const current = hostedFixture({
    env: { B: "2", A: "1" },
    secretEnvKeys: ["KEEP", "DROP", "MOVE"],
  });

  it("sends nothing when nothing changed, and only the name on a rename", () => {
    expect(toHostedUpdate(hostedDefaults(current), current)).toEqual({});
    expect(toHostedUpdate({ ...hostedDefaults(current), name: "Thinker" }, current)).toEqual({
      name: "Thinker",
    });
  });

  it("keeps blank stored secrets, removes dropped ones, and moves one to plain", () => {
    const values = hostedDefaults(current);
    values.size = "medium";
    values.env = values.env
      .filter((r) => r.name !== "DROP")
      .map((r) => (r.name === "MOVE" ? { ...r, secret: false, value: "visible" } : r));
    values.env.push({ name: "NEW", value: "n3w", secret: true, stored: false });
    expect(toHostedUpdate(values, current)).toEqual({
      size: "medium",
      env: { B: "2", A: "1", MOVE: "visible" },
      secretEnv: { DROP: null, MOVE: null, NEW: "n3w" },
    });
  });
});
