import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { log } from "../logger.js";

/** An error that's safe to show the caller as-is. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new HttpError(404, "not_found", `${what} not found`);

/** Parses with zod; a failure becomes a 400 listing each problem. */
export function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const problems = result.error.issues
      .map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message))
      .join("; ");
    throw new HttpError(400, "invalid_request", problems);
  }
  return result.data;
}

/** Postgres unique violation -> 409, so a duplicate slug/email isn't a 500. */
export function conflictOnDuplicate(what: string) {
  return (err: unknown): never => {
    if ((err as { code?: string }).code === "23505") {
      throw new HttpError(409, "conflict", `${what} already exists`);
    }
    throw err;
  };
}

/** Express 5 forwards rejected async handlers here. Never echo internals. */
// Express recognises error handlers by their four parameters.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message } });
    return;
  }
  const status = (err as { status?: number }).status;
  if (status && status >= 400 && status < 500) {
    // e.g. malformed JSON body from express.json()
    res.status(status).json({ error: { code: "bad_request", message: "Malformed request" } });
    return;
  }
  log("error", "unhandled request error", {
    error: err instanceof Error ? err.message : String(err),
  });
  res.status(500).json({ error: { code: "internal", message: "Internal server error" } });
}
