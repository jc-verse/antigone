import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import type { SensitiveOperation } from "../auth/sensitive-authorization";

const date = () => integer({ mode: "timestamp_ms" });

export const user = sqliteTable("user", {
  id: text().primaryKey(),
  name: text().notNull(),
  email: text().notNull().unique(),
  emailVerified: integer({ mode: "boolean" }).notNull().default(false),
  image: text(),
  createdAt: date().notNull(),
  updatedAt: date().notNull(),
  twoFactorEnabled: integer({ mode: "boolean" }).default(false),
  passwordChanged: integer({ mode: "boolean" }).default(false),
});
export const session = sqliteTable(
  "session",
  {
    id: text().primaryKey(),
    expiresAt: date().notNull(),
    token: text().notNull().unique(),
    createdAt: date().notNull(),
    updatedAt: date().notNull(),
    ipAddress: text(),
    userAgent: text(),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [index("session_userId_idx").on(table.userId)],
);
export const account = sqliteTable(
  "account",
  {
    id: text().primaryKey(),
    accountId: text().notNull(),
    providerId: text().notNull(),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text(),
    refreshToken: text(),
    idToken: text(),
    accessTokenExpiresAt: date(),
    refreshTokenExpiresAt: date(),
    scope: text(),
    password: text(),
    createdAt: date().notNull(),
    updatedAt: date().notNull(),
  },
  (table) => [index("account_userId_idx").on(table.userId)],
);
export const verification = sqliteTable(
  "verification",
  {
    id: text().primaryKey(),
    identifier: text().notNull(),
    value: text().notNull(),
    expiresAt: date().notNull(),
    createdAt: date().notNull(),
    updatedAt: date().notNull(),
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
);
export const twoFactor = sqliteTable(
  "twoFactor",
  {
    id: text().primaryKey(),
    secret: text().notNull(),
    backupCodes: text().notNull(),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    verified: integer({ mode: "boolean" }).default(true),
    failedVerificationCount: integer().default(0),
    lockedUntil: date(),
  },
  (table) => [
    index("twoFactor_userId_idx").on(table.userId),
    index("twoFactor_secret_idx").on(table.secret),
  ],
);
export const passkey = sqliteTable(
  "passkey",
  {
    id: text().primaryKey(),
    name: text(),
    publicKey: text().notNull(),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    credentialID: text().notNull(),
    counter: integer().notNull(),
    deviceType: text().notNull(),
    backedUp: integer({ mode: "boolean" }).notNull(),
    transports: text(),
    createdAt: date(),
    aaguid: text(),
  },
  (table) => [
    index("passkey_userId_idx").on(table.userId),
    index("passkey_credentialID_idx").on(table.credentialID),
  ],
);
export const rateLimit = sqliteTable("rateLimit", {
  id: text().primaryKey(),
  key: text().notNull().unique(),
  count: integer().notNull(),
  lastRequest: integer().notNull(),
});
export const sensitiveAuthorization = sqliteTable("sensitiveAuthorization", {
  sessionId: text()
    .primaryKey()
    .references(() => session.id, { onDelete: "cascade" }),
  operation: text().$type<SensitiveOperation>().notNull(),
  target: text(),
  expiresAt: integer().notNull(),
  pendingPasswordHash: text(),
  pendingAuthenticator: text(),
  pendingRecoveryCodes: text(),
});
export const runpodSetup = sqliteTable(
  "runpod_setup",
  { id: integer().primaryKey(), state: text().notNull() },
  (table) => [check("runpod_setup_singleton", sql`${table.id} = 1`)],
);
