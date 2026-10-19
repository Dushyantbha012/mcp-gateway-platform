import type { Role } from "../db/schema.js";

/**
 * One permission rule. `toolName` is the upstream's own tool name (not the
 * exposed `slug__tool` form, which can be sanitised or hashed); null means the
 * rule covers every tool of the server, including ones added later.
 */
export interface PermissionRule {
  subjectType: "role" | "user";
  /** A role name for role rules, a user id for user rules. */
  subject: string;
  serverSlug: string;
  toolName: string | null;
  effect: "allow" | "deny";
}

export interface Subject {
  userId: string;
  role: Role;
}

export interface ToolRef {
  serverSlug: string;
  toolName: string;
  /** The upstream marked the tool `readOnlyHint: true`. Absent/false = it may change things. */
  readOnly?: boolean;
}

/**
 * What a member may use when no rule matches. `readOnly`: only tools the
 * upstream marks read-only (an admin Allow rule grants the rest). `allowAll`:
 * everything, until a Deny rule says otherwise.
 */
export type MemberDefault = "readOnly" | "allowAll";

export type Decision =
  | { allowed: true; reason: "admin" | "default" | "rule"; rule?: PermissionRule }
  | { allowed: false; reason: "rule"; rule: PermissionRule }
  | { allowed: false; reason: "read-only-default" };

/**
 * Most specific rule wins. Who the rule is for outranks what it covers: a rule
 * for this very user beats a rule for their role, and within the same subject
 * a tool rule beats a server rule. On a tie, deny beats allow.
 */
const rank = (r: PermissionRule): number =>
  (r.subjectType === "user" ? 2 : 0) + (r.toolName === null ? 0 : 1);

/**
 * The single decision function behind tools/list, tools/call, the chat agent
 * and the admin preview - they can't disagree because they all call this.
 *
 * Admins are never restricted (an admin can't lock themselves out); everyone
 * else follows the matching rule, or the member default when there is none.
 */
export function decide(
  subject: Subject,
  tool: ToolRef,
  rules: PermissionRule[],
  memberDefault: MemberDefault = "allowAll",
): Decision {
  if (subject.role === "admin") return { allowed: true, reason: "admin" };

  let best: PermissionRule | undefined;
  for (const r of rules) {
    if (r.serverSlug !== tool.serverSlug) continue;
    if (r.toolName !== null && r.toolName !== tool.toolName) continue;
    const mine =
      r.subjectType === "user" ? r.subject === subject.userId : r.subject === subject.role;
    if (!mine) continue;
    if (
      !best ||
      rank(r) > rank(best) ||
      (rank(r) === rank(best) && r.effect === "deny" && best.effect === "allow")
    ) {
      best = r;
    }
  }

  if (!best) {
    return memberDefault === "readOnly" && tool.readOnly !== true
      ? { allowed: false, reason: "read-only-default" }
      : { allowed: true, reason: "default" };
  }
  return best.effect === "allow"
    ? { allowed: true, reason: "rule", rule: best }
    : { allowed: false, reason: "rule", rule: best };
}

export const isAllowed = (
  subject: Subject,
  tool: ToolRef,
  rules: PermissionRule[],
  memberDefault: MemberDefault = "allowAll",
): boolean => decide(subject, tool, rules, memberDefault).allowed;
