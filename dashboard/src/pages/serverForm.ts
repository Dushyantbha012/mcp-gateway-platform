import { z } from "zod";
import type { AuthType, Server, ServerInput } from "@/api/types";

/**
 * Client-side mirror of the gateway's server validation
 * (gateway/src/api/servers.ts), so most mistakes show next to the field.
 * The gateway still validates everything; its message is shown if it
 * disagrees.
 */
export const SLUG_PATTERN = /^[a-z][a-z0-9-]{1,30}$/;
const HEADER_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
const RESERVED_HEADERS = new Set([
  "host",
  "content-type",
  "content-length",
  "accept",
  "connection",
  "transfer-encoding",
  "mcp-session-id",
  "mcp-protocol-version",
  "last-event-id",
]);

export interface ServerFormValues {
  slug: string;
  name: string;
  url: string;
  authType: AuthType;
  authHeaderName: string;
  credential: string;
  timeoutMs: number;
}

/**
 * On create a credential is required for bearer/header auth. On edit the
 * stored credential is never sent back to the browser: leaving the field
 * blank keeps it, so it's only required if none is stored yet.
 */
export function serverFormSchema(opts: { hasStoredCredential: boolean }) {
  return z
    .object({
      slug: z
        .string()
        .regex(
          SLUG_PATTERN,
          "2-31 chars: lowercase letters, digits and dashes, starting with a letter",
        ),
      name: z.string().trim().min(1, "Required").max(100),
      url: z.url({ protocol: /^https?$/, error: "Must be an http(s) URL" }),
      authType: z.enum(["none", "bearer", "header"]),
      authHeaderName: z.string(),
      credential: z.string().max(4096),
      timeoutMs: z
        .number({ error: "Must be a number" })
        .int("Must be a whole number")
        .min(100, "At least 100 ms")
        .max(120_000, "At most 120000 ms"),
    })
    .superRefine((v, ctx) => {
      if (v.authType === "header") {
        if (!HEADER_PATTERN.test(v.authHeaderName)) {
          ctx.addIssue({
            code: "custom",
            path: ["authHeaderName"],
            message: "A valid HTTP header name",
          });
        } else if (RESERVED_HEADERS.has(v.authHeaderName.toLowerCase())) {
          ctx.addIssue({
            code: "custom",
            path: ["authHeaderName"],
            message: "Reserved by the MCP transport",
          });
        }
      }
      if (v.authType !== "none" && !v.credential && !opts.hasStoredCredential) {
        ctx.addIssue({
          code: "custom",
          path: ["credential"],
          message: "Required for this auth type",
        });
      }
    });
}

export function defaultsFor(server?: Server): ServerFormValues {
  return {
    slug: server?.slug ?? "",
    name: server?.name ?? "",
    url: server?.url ?? "",
    authType: server?.authType ?? "none",
    authHeaderName: server?.authHeaderName ?? "",
    credential: "", // never prefilled
    timeoutMs: server?.timeoutMs ?? 10_000,
  };
}

/** What to send: only meaningful fields, and the credential only if typed. */
export function toInput(v: ServerFormValues): ServerInput {
  return {
    slug: v.slug,
    name: v.name.trim(),
    url: v.url,
    authType: v.authType,
    ...(v.authType === "header" ? { authHeaderName: v.authHeaderName } : {}),
    ...(v.authType !== "none" && v.credential ? { credential: v.credential } : {}),
    timeoutMs: v.timeoutMs,
  };
}
