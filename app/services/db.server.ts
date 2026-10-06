import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import type { BetterAuthOptions } from "better-auth";
import { hashPassword } from "better-auth/crypto";
import { getMigrations } from "better-auth/db/migration";

mkdirSync("/data", { recursive: true, mode: 0o700 });
const path = "/data/antigone.sqlite3";
export const db = new Database(path, { create: true, strict: true });
chmodSync(path, 0o600);
db.run("PRAGMA busy_timeout = 10000");
db.run(
  "CREATE TABLE IF NOT EXISTS runpod_setup (id INTEGER PRIMARY KEY CHECK(id = 1), state TEXT NOT NULL)",
);

export async function initializeAuthDatabase(
  options: BetterAuthOptions,
): Promise<void> {
  const schema = await getMigrations(options);
  await schema.runMigrations();
  if (db.prepare('SELECT id FROM "user" WHERE id=?').get("owner")) return;
  const initialPassword = process.env.INIT_PASSWORD ?? "";
  if (initialPassword.length < 32) {
    throw new Error(
      "Set INIT_PASSWORD to at least 32 characters before first startup",
    );
  }
  const password = await hashPassword(initialPassword);
  db.transaction(() => {
    if (db.prepare('SELECT id FROM "user" WHERE id=?').get("owner")) return;
    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt", "twoFactorEnabled", passwordChanged) VALUES (?,?,?,?,?,?,?,?)',
    ).run("owner", "Owner", "owner@antigone.invalid", 1, now, now, 0, 0);
    db.prepare(
      'INSERT INTO "account" (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt") VALUES (?,?,?,?,?,?,?)',
    ).run(
      "owner-credential",
      "owner",
      "credential",
      "owner",
      password,
      now,
      now,
    );
  })();
}
