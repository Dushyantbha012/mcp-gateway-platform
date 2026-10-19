import { currentRequestId } from "./requestContext.js";

/**
 * One JSON object per line on stdout, which `kubectl logs` and any log
 * collector can parse. Callers must never pass secrets or auth headers.
 * Lines written while handling a request carry its `requestId`.
 */
export function log(level: "info" | "warn" | "error", msg: string, fields: object = {}): void {
  if (process.env.NODE_ENV === "test" && level !== "error") return;
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      level,
      msg,
      requestId: currentRequestId(),
      ...fields,
    }),
  );
}
