import { createHash } from "node:crypto";
import type { Db } from "./db.js";
import type { WriteApproval } from "./schema.js";

/** How long a pending request, or an approval nobody has used yet, stays valid. */
export const APPROVAL_TTL_MS = 10 * 60_000;

/** Key that is equal for equal JSON whatever the order of an object's keys. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

export const hashArgs = (args: Record<string, unknown> | undefined): string =>
  createHash("sha256")
    .update(canonicalJson(args ?? {}))
    .digest("hex");

export type Gate =
  | { kind: "run" }
  | { kind: "pending"; id: string }
  | { kind: "denied"; id: string }
  | { kind: "created"; id: string };

/**
 * What an MCP write call may do right now, for this user, tool and exact arguments:
 * an approved, unused, unexpired approval is used up (once) and lets it run; a
 * pending one means "still waiting"; otherwise a new pending request is made.
 * The use is one atomic UPDATE, so two replicas can't both spend one approval.
 */
export async function gateWrite(
  db: Db,
  userId: string,
  toolName: string,
  args: Record<string, unknown> | undefined,
  now = new Date(),
): Promise<Gate> {
  const argsHash = hashArgs(args);
  const used = await db
    .updateTable("write_approvals")
    .set({ used_at: now })
    .where("id", "in", (eb) =>
      eb
        .selectFrom("write_approvals")
        .select("id")
        .where("user_id", "=", userId)
        .where("tool_name", "=", toolName)
        .where("args_hash", "=", argsHash)
        .where("status", "=", "approved")
        .where("used_at", "is", null)
        .where("expires_at", ">", now)
        .limit(1),
    )
    .where("used_at", "is", null)
    .returning("id")
    .executeTakeFirst();
  if (used) return { kind: "run" };

  const open = await db
    .selectFrom("write_approvals")
    .select(["id", "status"])
    .where("user_id", "=", userId)
    .where("tool_name", "=", toolName)
    .where("args_hash", "=", argsHash)
    .where("used_at", "is", null)
    .where("expires_at", ">", now)
    .where("status", "in", ["pending", "denied"])
    .orderBy("created_at", "desc")
    .executeTakeFirst();
  if (open) return { kind: open.status === "denied" ? "denied" : "pending", id: open.id };

  const row = await db
    .insertInto("write_approvals")
    .values({
      user_id: userId,
      tool_name: toolName,
      args: JSON.stringify(args ?? {}),
      args_hash: argsHash,
      expires_at: new Date(now.getTime() + APPROVAL_TTL_MS),
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return { kind: "created", id: row.id };
}

export function listPending(db: Db, userId: string, now = new Date()): Promise<WriteApproval[]> {
  return db
    .selectFrom("write_approvals")
    .selectAll()
    .where("user_id", "=", userId)
    .where("status", "=", "pending")
    .where("expires_at", ">", now)
    .orderBy("created_at", "desc")
    .execute();
}

/** Decides one of the user's own pending requests; false if it isn't theirs, isn't pending or expired. */
export async function decide(
  db: Db,
  userId: string,
  id: string,
  decision: "approved" | "denied",
  now = new Date(),
): Promise<boolean> {
  const res = await db
    .updateTable("write_approvals")
    .set({ status: decision, decided_at: now })
    .where("id", "=", id)
    .where("user_id", "=", userId)
    .where("status", "=", "pending")
    .where("expires_at", ">", now)
    .executeTakeFirst();
  return Number(res.numUpdatedRows) === 1;
}
