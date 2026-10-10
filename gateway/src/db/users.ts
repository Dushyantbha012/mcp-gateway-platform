import type { Db } from "./db.js";
import type { Role, User } from "./schema.js";

export function listUsers(db: Db): Promise<User[]> {
  return db.selectFrom("users").selectAll().orderBy("created_at").execute();
}

export function getUser(db: Db, id: string): Promise<User | undefined> {
  return db.selectFrom("users").selectAll().where("id", "=", id).executeTakeFirst();
}

export function findUserByEmail(db: Db, email: string): Promise<User | undefined> {
  return db
    .selectFrom("users")
    .selectAll()
    .where("email", "=", email.toLowerCase())
    .executeTakeFirst();
}

export function createUser(
  db: Db,
  user: { email: string; name: string; role: Role },
): Promise<User> {
  return db
    .insertInto("users")
    .values({ ...user, email: user.email.toLowerCase() })
    .returningAll()
    .executeTakeFirstOrThrow();
}
