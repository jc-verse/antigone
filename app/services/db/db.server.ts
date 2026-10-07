import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { hashPassword } from "better-auth/crypto";
import * as schema from "./schema";

mkdirSync("/data", { recursive: true, mode: 0o700 });
const path = "/data/antigone.sqlite3";
const sqlite = new Database(path, { create: true, strict: true });
chmodSync(path, 0o600);
sqlite.run("PRAGMA busy_timeout = 10000");
sqlite.run("PRAGMA foreign_keys = ON");
export const db = drizzle(sqlite, { schema });

export async function initializeAuthDatabase(): Promise<void> {
  if (
    db
      .select({ id: schema.user.id })
      .from(schema.user)
      .where(eq(schema.user.id, "owner"))
      .get()
  )
    return;
  const initialPassword = process.env.INIT_PASSWORD ?? "";
  if (initialPassword.length < 32) {
    throw new Error(
      "Set INIT_PASSWORD to at least 32 characters before first startup",
    );
  }
  const password = await hashPassword(initialPassword);
  db.transaction((tx) => {
    if (
      tx
        .select({ id: schema.user.id })
        .from(schema.user)
        .where(eq(schema.user.id, "owner"))
        .get()
    )
      return;
    const now = new Date();
    tx.insert(schema.user)
      .values({
        id: "owner",
        name: "Owner",
        email: "owner@antigone.invalid",
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
        twoFactorEnabled: false,
        passwordChanged: false,
      })
      .run();
    tx.insert(schema.account)
      .values({
        id: "owner-credential",
        accountId: "owner",
        providerId: "credential",
        userId: "owner",
        password,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  });
}
