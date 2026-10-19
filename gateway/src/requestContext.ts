import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

interface RequestStore {
  requestId: string;
}

const storage = new AsyncLocalStorage<RequestStore>();

/** The caller's ID is only trusted for correlation, so keep it log-safe. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{8,128}$/;

export const REQUEST_ID_HEADER = "X-Request-ID";

/** The ID of the request being handled right now, if any (absent in background work). */
export function currentRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

export function runWithRequestId<T>(requestId: string, fn: () => T): T {
  return storage.run({ requestId }, fn);
}

/**
 * Gives every request an ID that appears in its response header, in every log
 * line written while handling it, and in the audit rows it produces. A
 * well-formed `X-Request-ID` from the caller is kept so a trace can span
 * services; anything else is replaced, so a client can't inject odd
 * characters into the logs.
 */
export function requestId() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const inbound = req.get(REQUEST_ID_HEADER);
    const id = inbound !== undefined && SAFE_REQUEST_ID.test(inbound) ? inbound : randomUUID();
    res.setHeader(REQUEST_ID_HEADER, id);
    res.locals.requestId = id;
    runWithRequestId(id, next);
  };
}
