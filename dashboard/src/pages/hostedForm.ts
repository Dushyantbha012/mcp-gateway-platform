import { z } from "zod";
import type { Hosted, HostedInput } from "@/api/types";
import { SLUG_PATTERN } from "@/pages/serverForm";

/**
 * Client-side mirror of the gateway's hosted-server validation
 * (gateway/src/api/hosted.ts). The image allowlist is only checked there;
 * its message is shown if it refuses.
 */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const RESERVED_ENV = /^BRIDGE_/;
const PATH = /^\/[A-Za-z0-9._~/-]*$/;
export const MAX_ENV = 50;

export interface EnvRow {
  name: string;
  value: string;
  secret: boolean;
  /** A secret the gateway already holds: a blank value keeps it. */
  stored: boolean;
}

export interface HostedFormValues {
  slug: string;
  name: string;
  image: string;
  transport: "stdio" | "http";
  command: string;
  port: number;
  path: string;
  libc: "glibc" | "musl";
  env: EnvRow[];
  authTokenEnv: string;
  egress: "none" | "internet";
  size: "small" | "medium";
}

/** `node "my dir/x.js" --flag` -> ["node", "my dir/x.js", "--flag"]: whitespace, with '…' / "…" quoting. */
export function splitCommand(line: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: string | null = null;
  let started = false;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) out.push(current);
      current = "";
      started = false;
    } else {
      current += ch;
      started = true;
    }
  }
  if (started) out.push(current);
  return out;
}

/** The reverse, for showing a stored command in the field. */
export function joinCommand(args: string[]): string {
  return args
    .map((a) => (a === "" || /[\s"']/.test(a) ? (a.includes('"') ? `'${a}'` : `"${a}"`) : a))
    .join(" ");
}

export const hostedFormSchema = z
  .object({
    slug: z
      .string()
      .regex(
        SLUG_PATTERN,
        "2-31 chars: lowercase letters, digits and dashes, starting with a letter",
      ),
    name: z.string().trim().min(1, "Required").max(100),
    image: z
      .string()
      .trim()
      .min(1, "Required")
      .max(255)
      .refine((i) => !/\s/.test(i), "No spaces in an image reference"),
    transport: z.enum(["stdio", "http"]),
    command: z.string().max(4096),
    port: z
      .number({ error: "Must be a number" })
      .int("Must be a whole number")
      .min(1, "1-65535")
      .max(65535, "1-65535"),
    path: z.string().max(255).regex(PATH, "A URL path starting with /"),
    libc: z.enum(["glibc", "musl"]),
    env: z.array(
      z.object({
        name: z.string(),
        value: z.string().max(4096, "At most 4096 characters"),
        secret: z.boolean(),
        stored: z.boolean(),
      }),
    ),
    authTokenEnv: z.string(),
    egress: z.enum(["none", "internet"]),
    size: z.enum(["small", "medium"]),
  })
  .superRefine((v, ctx) => {
    const unterminated = (v.command.match(/["']/g)?.length ?? 0) % 2 !== 0;
    if (unterminated) {
      ctx.addIssue({ code: "custom", path: ["command"], message: "Unclosed quote" });
    } else if (v.transport === "stdio" && splitCommand(v.command).length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["command"],
        message: "Required: the bridge runs it in place of the image's entrypoint",
      });
    }
    const seen = new Set<string>();
    v.env.forEach((row, i) => {
      if (!ENV_NAME.test(row.name)) {
        ctx.addIssue({ code: "custom", path: ["env", i, "name"], message: "Not a valid name" });
      } else if (RESERVED_ENV.test(row.name)) {
        ctx.addIssue({
          code: "custom",
          path: ["env", i, "name"],
          message: "BRIDGE_* is reserved",
        });
      } else if (seen.has(row.name)) {
        ctx.addIssue({ code: "custom", path: ["env", i, "name"], message: "Listed twice" });
      } else if (row.name === v.authTokenEnv.trim() && v.transport === "http") {
        ctx.addIssue({
          code: "custom",
          path: ["env", i, "name"],
          message: "Set by the provisioner (auth token)",
        });
      }
      seen.add(row.name);
      if (row.secret && !row.stored && !row.value) {
        ctx.addIssue({ code: "custom", path: ["env", i, "value"], message: "Required" });
      }
    });
    if (v.env.length > MAX_ENV) {
      ctx.addIssue({ code: "custom", path: ["env"], message: `At most ${MAX_ENV} variables` });
    }
    const token = v.authTokenEnv.trim();
    if (v.transport === "http" && token) {
      if (!ENV_NAME.test(token)) {
        ctx.addIssue({ code: "custom", path: ["authTokenEnv"], message: "Not a valid name" });
      } else if (RESERVED_ENV.test(token)) {
        ctx.addIssue({ code: "custom", path: ["authTokenEnv"], message: "BRIDGE_* is reserved" });
      }
    }
  });

export function hostedDefaults(hosted?: Hosted): HostedFormValues {
  if (!hosted) {
    return {
      slug: "",
      name: "",
      image: "",
      transport: "stdio",
      command: "",
      port: 8080,
      path: "/mcp",
      libc: "glibc",
      env: [],
      authTokenEnv: "",
      egress: "none",
      size: "small",
    };
  }
  return {
    slug: hosted.slug,
    name: hosted.name,
    image: hosted.image,
    transport: hosted.transport,
    command: joinCommand(hosted.command),
    port: hosted.port,
    path: hosted.path,
    libc: hosted.libc,
    env: [
      ...Object.entries(hosted.env).map(([name, value]) => ({
        name,
        value,
        secret: false,
        stored: false,
      })),
      // Values are write-only: shown blank, kept unless one is typed.
      ...hosted.secretEnvKeys.map((name) => ({ name, value: "", secret: true, stored: true })),
    ],
    authTokenEnv: hosted.authTokenEnv ?? "",
    egress: hosted.egress,
    size: hosted.size,
  };
}

/** The whole spec, as a create body. */
export function toHostedInput(v: HostedFormValues): HostedInput {
  const http = v.transport === "http";
  return {
    slug: v.slug,
    name: v.name.trim(),
    image: v.image.trim(),
    transport: v.transport,
    command: splitCommand(v.command),
    // The bridge always listens on 8080 and serves /mcp.
    port: http ? v.port : 8080,
    path: http ? v.path : "/mcp",
    libc: v.libc,
    env: Object.fromEntries(v.env.filter((r) => !r.secret).map((r) => [r.name, r.value])),
    secretEnv: Object.fromEntries(v.env.filter((r) => r.secret).map((r) => [r.name, r.value])),
    authTokenEnv: http && v.authTokenEnv.trim() ? v.authTokenEnv.trim() : null,
    egress: v.egress,
    size: v.size,
  };
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const sortedEntries = (m: Record<string, string>) =>
  Object.fromEntries(Object.entries(m).sort(([a], [b]) => a.localeCompare(b)));

/**
 * Only what changed: the gateway redeploys the pod for any field it is
 * sent other than the name, so an untouched field must stay out.
 */
export function toHostedUpdate(v: HostedFormValues, current: Hosted): Partial<HostedInput> {
  const next = toHostedInput(v);
  const out: Partial<HostedInput> = {};
  if (next.name !== current.name) out.name = next.name;
  if (next.image !== current.image) out.image = next.image;
  if (!sameJson(next.command, current.command)) out.command = next.command;
  if (next.port !== current.port) out.port = next.port;
  if (next.path !== current.path) out.path = next.path;
  if (next.libc !== current.libc) out.libc = next.libc;
  if (!sameJson(sortedEntries(next.env), sortedEntries(current.env))) out.env = next.env;
  if (next.authTokenEnv !== current.authTokenEnv) out.authTokenEnv = next.authTokenEnv;
  if (next.egress !== current.egress) out.egress = next.egress;
  if (next.size !== current.size) out.size = next.size;

  const secretEnv: Record<string, string | null> = {};
  for (const key of current.secretEnvKeys) {
    if (!(key in next.secretEnv)) secretEnv[key] = null; // removed, or now a plain variable
  }
  for (const [key, value] of Object.entries(next.secretEnv)) {
    if (value) secretEnv[key] = value; // blank = keep the stored value
  }
  if (Object.keys(secretEnv).length) out.secretEnv = secretEnv;
  return out;
}
