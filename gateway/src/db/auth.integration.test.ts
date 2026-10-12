import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateApiKey, hashApiKey } from "../crypto/apiKeys.js";
import { hashToken } from "../crypto/tokens.js";
import { createTestDatabase, hasTestDb, type TestDatabase } from "../test/testDb.js";
import { findPrincipalByKeyHash, insertApiKey } from "./apiKeys.js";
import { acceptInvite, createInvite, findValidInvite } from "./invites.js";
import {
  createSession,
  deleteSession,
  deleteUserSessions,
  findPrincipalBySessionHash,
  touchSession,
} from "./sessions.js";
import { createUser, getUser, LastAdminError, updateUser } from "./users.js";

const HOUR = 3_600_000;

describe.skipIf(!hasTestDb)("sessions, invites and user changes", () => {
  let t: TestDatabase;
  let n = 0;
  const user = (role: "admin" | "member" = "member") =>
    createUser(t.db, { email: `u${++n}@example.com`, name: `U${n}`, role });

  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t?.drop();
  });

  describe("sessions", () => {
    it("resolve to their user until deleted, and store only a hash", async () => {
      const u = await user();
      const s = await createSession(t.db, u.id, HOUR);
      expect(await findPrincipalBySessionHash(t.db, hashToken(s.token))).toEqual({
        userId: u.id,
        email: u.email,
        role: "member",
        authMethod: "session",
        keyId: null,
        sessionId: s.id,
      });
      const rows = await t.db.selectFrom("sessions").selectAll().where("id", "=", s.id).execute();
      expect(rows[0].token_hash.equals(hashToken(s.token))).toBe(true);
      expect(JSON.stringify(rows)).not.toContain(s.token);

      await deleteSession(t.db, s.id);
      expect(await findPrincipalBySessionHash(t.db, hashToken(s.token))).toBeUndefined();
    });

    it("stop resolving once expired, and expired ones are cleared on the next login", async () => {
      const u = await user();
      const s = await createSession(t.db, u.id, HOUR);
      await t.db
        .updateTable("sessions")
        .set({ expires_at: sql<Date>`now() - interval '1 second'` })
        .where("id", "=", s.id)
        .execute();
      expect(await findPrincipalBySessionHash(t.db, hashToken(s.token))).toBeUndefined();
      await createSession(t.db, u.id, HOUR);
      const left = await t.db
        .selectFrom("sessions")
        .select("id")
        .where("user_id", "=", u.id)
        .execute();
      expect(left.map((r) => r.id)).not.toContain(s.id);
    });

    it("can all be ended for a user, optionally keeping the current one", async () => {
      const u = await user();
      const [a, b, c] = await Promise.all([1, 2, 3].map(() => createSession(t.db, u.id, HOUR)));
      expect(await deleteUserSessions(t.db, u.id, { except: a.id })).toBe(2);
      expect(await findPrincipalBySessionHash(t.db, hashToken(a.token))).toBeDefined();
      expect(await findPrincipalBySessionHash(t.db, hashToken(b.token))).toBeUndefined();
      expect(await findPrincipalBySessionHash(t.db, hashToken(c.token))).toBeUndefined();
    });

    it("touch updates last_seen_at at most once a minute", async () => {
      const u = await user();
      const s = await createSession(t.db, u.id, HOUR);
      const seen = () =>
        t.db
          .selectFrom("sessions")
          .select("last_seen_at")
          .where("id", "=", s.id)
          .executeTakeFirstOrThrow();
      const before = (await seen()).last_seen_at;
      await touchSession(t.db, s.id);
      expect((await seen()).last_seen_at).toEqual(before);
      await t.db
        .updateTable("sessions")
        .set({ last_seen_at: sql<Date>`now() - interval '2 minutes'` })
        .where("id", "=", s.id)
        .execute();
      await touchSession(t.db, s.id);
      expect((await seen()).last_seen_at.getTime()).toBeGreaterThan(Date.now() - 10_000);
    });
  });

  describe("invites", () => {
    it("are found by token, accepted once, and set the password", async () => {
      const u = await user();
      const inv = await createInvite(t.db, { userId: u.id, createdBy: null, ttlMs: HOUR });
      const found = await findValidInvite(t.db, hashToken(inv.token));
      expect(found?.user.id).toBe(u.id);
      const old = await createSession(t.db, u.id, HOUR);

      expect(await acceptInvite(t.db, found!.inviteId, u.id, "scrypt$hash")).toBe(true);
      expect((await getUser(t.db, u.id))?.password_hash).toBe("scrypt$hash");
      // Accepting logs the user out everywhere else (it doubles as a password reset).
      expect(await findPrincipalBySessionHash(t.db, hashToken(old.token))).toBeUndefined();
      // Single use.
      expect(await findValidInvite(t.db, hashToken(inv.token))).toBeUndefined();
      expect(await acceptInvite(t.db, found!.inviteId, u.id, "scrypt$other")).toBe(false);
      expect((await getUser(t.db, u.id))?.password_hash).toBe("scrypt$hash");
    });

    it("are single-use even when accepted twice at the same moment", async () => {
      const u = await user();
      const inv = await createInvite(t.db, { userId: u.id, createdBy: null, ttlMs: HOUR });
      const { inviteId } = (await findValidInvite(t.db, hashToken(inv.token)))!;
      const results = await Promise.all([
        acceptInvite(t.db, inviteId, u.id, "scrypt$a"),
        acceptInvite(t.db, inviteId, u.id, "scrypt$b"),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it("a newer invite voids the older one", async () => {
      const u = await user();
      const first = await createInvite(t.db, { userId: u.id, createdBy: null, ttlMs: HOUR });
      const second = await createInvite(t.db, { userId: u.id, createdBy: null, ttlMs: HOUR });
      expect(await findValidInvite(t.db, hashToken(first.token))).toBeUndefined();
      expect(await findValidInvite(t.db, hashToken(second.token))).toBeDefined();
    });

    it("are not valid once expired or for a disabled user", async () => {
      const a = await user();
      const expired = await createInvite(t.db, { userId: a.id, createdBy: null, ttlMs: -60_000 });
      expect(await findValidInvite(t.db, hashToken(expired.token))).toBeUndefined();

      const b = await user();
      const inv = await createInvite(t.db, { userId: b.id, createdBy: null, ttlMs: HOUR });
      await t.db
        .updateTable("users")
        .set({ disabled_at: new Date() })
        .where("id", "=", b.id)
        .execute();
      expect(await findValidInvite(t.db, hashToken(inv.token))).toBeUndefined();
    });
  });

  describe("updateUser", () => {
    it("disabling ends sessions and stops API keys; re-enabling restores keys only", async () => {
      await user("admin"); // so this isn't about the last admin
      const u = await user();
      const s = await createSession(t.db, u.id, HOUR);
      const k = generateApiKey();
      await insertApiKey(t.db, { userId: u.id, name: "k", ...k });

      const disabled = await updateUser(t.db, u.id, { disabled: true });
      expect(disabled?.disabled_at).toBeInstanceOf(Date);
      expect(await findPrincipalBySessionHash(t.db, hashToken(s.token))).toBeUndefined();
      expect(await findPrincipalByKeyHash(t.db, hashApiKey(k.key))).toBeUndefined();
      const sessions = await t.db
        .selectFrom("sessions")
        .select("id")
        .where("user_id", "=", u.id)
        .execute();
      expect(sessions).toHaveLength(0);

      // Disabling again keeps the original timestamp.
      const again = await updateUser(t.db, u.id, { disabled: true });
      expect(again?.disabled_at).toEqual(disabled?.disabled_at);

      const enabled = await updateUser(t.db, u.id, { disabled: false });
      expect(enabled?.disabled_at).toBeNull();
      expect(await findPrincipalByKeyHash(t.db, hashApiKey(k.key))).toBeDefined();
    });

    it("changes name and role, and returns undefined for an unknown id", async () => {
      const u = await user();
      const changed = await updateUser(t.db, u.id, { name: "Renamed", role: "admin" });
      expect(changed).toMatchObject({ name: "Renamed", role: "admin" });
      expect(
        await updateUser(t.db, "00000000-0000-0000-0000-000000000000", { name: "x" }),
      ).toBeUndefined();
    });

    it("never leaves zero enabled admins, even when two admins demote each other at once", async () => {
      const iso = await createTestDatabase();
      try {
        const a = await createUser(iso.db, { email: "a@x.io", name: "A", role: "admin" });
        const b = await createUser(iso.db, { email: "b@x.io", name: "B", role: "admin" });
        const results = await Promise.allSettled([
          updateUser(iso.db, a.id, { role: "member" }),
          updateUser(iso.db, b.id, { disabled: true }),
        ]);
        const rejected = results.filter((r) => r.status === "rejected");
        expect(rejected).toHaveLength(1);
        expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(LastAdminError);
        const admins = await iso.db
          .selectFrom("users")
          .select("id")
          .where("role", "=", "admin")
          .where("disabled_at", "is", null)
          .execute();
        expect(admins).toHaveLength(1);
        await expect(updateUser(iso.db, admins[0].id, { role: "member" })).rejects.toThrow(
          LastAdminError,
        );
      } finally {
        await iso.drop();
      }
    });
  });
});
