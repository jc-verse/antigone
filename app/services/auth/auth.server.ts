/**
 * This is THE MOST central file for auth management. Although all the heavy-
 * lifting is done by Better Auth, we still maintain a whole state machine,
 * especially for the onboarding workflow where there's a vulnerable period.
 *
 * At a high level, an Antigone user holds at least one of two sign-in methods:
 *
 * 1) Password + 2FA
 * 2) Passkey(s)
 *
 * The user is **never** allowed to hold just the password, because that would
 * become the attack vector.
 *
 * On initialization, the user only holds INIT_PASSWORD, but because we
 * specifically request a 32-character hex string, it's considered high-entropy
 * enough. A fresh session holds `status: "uninitialized"`.
 *
 * Once the init password is entered correctly, the session immediately enters
 * sensitive mode (more on this later), allowing the user to set up their real
 * password and 2FA without requiring re-auth. Both are committed atomically,
 * again to prevent the situation where a user holds a password but no 2FA.
 *
 * Once the user has fully onboarded, it is physically impossible to return to
 * the init password, or any password-only state, for that matter.
 *
 * A "sensitive session" is an even higher-trust authenticated session.
 * By default the auth you get when signing in is not sensitive.
 * You can only trigger a sensitive auth by requesting one of the sensitive
 * operations: change password, add passkey, etc.
 * In this case you'll be asked to re-authenticate.
 * Once successful, you'll have a sensitive session for 15 minutes.
 * If you completed the operation within 15 minutes the session will downgrade
 * immediately, so you cannot do something twice on the same session.
 * If you didn't complete it the session just downgrades and you need to
 * re-authenticate.
 */

import { createCookie, redirect } from "@remix-run/node";
import type { PublicKeyCredentialCreationOptionsJSON } from "@simplewebauthn/browser";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import {
  APIError,
  createAuthMiddleware,
  getSessionFromCtx,
} from "better-auth/api";
import { twoFactor } from "better-auth/plugins";
import { passkey } from "@better-auth/passkey";
import { createOTP } from "@better-auth/utils/otp";
import {
  generateRandomString,
  symmetricDecrypt,
  symmetricEncrypt,
} from "better-auth/crypto";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { and, eq, isNull, ne } from "drizzle-orm";
import { db, initializeAuthDatabase } from "../db/db.server";
import * as tables from "../db/schema";
import {
  isSetupAuthorization,
  type SensitiveAuthorization,
  type SensitiveOperation,
} from "./sensitive-authorization";

const appOrigin = new URL(process.env.APP_ORIGIN ?? "http://localhost:4410");
export function requireSameOrigin(request: Request): void {
  if (
    request.headers.get("Host") !== appOrigin.host ||
    request.headers.get("Origin") !== appOrigin.origin
  )
    throw Response.json({ detail: "Invalid origin" }, { status: 403 });
}
if (
  (appOrigin.protocol !== "https:" &&
    !(appOrigin.protocol === "http:" && appOrigin.hostname === "localhost")) ||
  appOrigin.username ||
  appOrigin.password ||
  appOrigin.pathname !== "/" ||
  appOrigin.search ||
  appOrigin.hash
) {
  throw new Error(
    "APP_ORIGIN must use HTTPS (or HTTP on localhost), without paths or credentials",
  );
}
const secret = process.env.BETTER_AUTH_SECRET;
if (!secret || secret.length < 32)
  throw new Error("Set BETTER_AUTH_SECRET to at least 32 random characters");

const sensitiveAuthMs = 15 * 60 * 1000;
const sensitiveIntentCookie = createCookie("antigone_sensitive_intent", {
  httpOnly: true,
  sameSite: "strict",
  secure: appOrigin.protocol === "https:",
  path: "/",
  maxAge: sensitiveAuthMs / 1000,
  secrets: [secret],
});
const sensitivePaths: { [path: string]: SensitiveOperation | undefined } = {
  "/change-password": "change-password",
  "/two-factor/enable": "replace-authenticator",
  "/two-factor/generate-backup-codes": "generate-recovery-codes",
  "/passkey/generate-register-options": "add-passkey",
  "/passkey/verify-registration": "add-passkey",
  "/passkey/delete-passkey": "remove-passkey",
};

function getSensitiveAuthorization(
  token: string,
): SensitiveAuthorization | null {
  const grant = db
    .select({
      operation: tables.sensitiveAuthorization.operation,
      target: tables.sensitiveAuthorization.target,
      expiresAt: tables.sensitiveAuthorization.expiresAt,
    })
    .from(tables.sensitiveAuthorization)
    .where(
      eq(
        tables.sensitiveAuthorization.sessionId,
        db
          .select({ id: tables.session.id })
          .from(tables.session)
          .where(eq(tables.session.token, token)),
      ),
    )
    .get();
  if (!grant) return null;
  if (grant.expiresAt <= Date.now()) {
    db.delete(tables.sensitiveAuthorization)
      .where(
        eq(
          tables.sensitiveAuthorization.sessionId,
          db
            .select({ id: tables.session.id })
            .from(tables.session)
            .where(eq(tables.session.token, token)),
        ),
      )
      .run();
    return null;
  }
  return grant;
}

function requireSensitiveAuthorization(
  token: string,
  operation: SensitiveOperation,
  target: string | null,
): SensitiveAuthorization {
  const grant = getSensitiveAuthorization(token);
  if (!grant || grant.operation !== operation || grant.target !== target) {
    throw new APIError("UNAUTHORIZED", {
      code: "SENSITIVE_AUTH_REQUIRED",
      message: "Verify your identity to authorize this operation",
    });
  }
  return grant;
}

function getPasswordChanged(): boolean {
  return Boolean(
    db
      .select({ passwordChanged: tables.user.passwordChanged })
      .from(tables.user)
      .where(eq(tables.user.id, "owner"))
      .get()?.passwordChanged,
  );
}

/**
 * During onboarding, the password remains uncommitted until 2FA is set up too.
 * This way there's never an intermediate state where there's a compromised
 * password but no 2FA.
 */
function getPendingPassword(token: string): string | null {
  return (
    db
      .select({
        pendingPasswordHash: tables.sensitiveAuthorization.pendingPasswordHash,
      })
      .from(tables.sensitiveAuthorization)
      .where(
        eq(
          tables.sensitiveAuthorization.sessionId,
          db
            .select({ id: tables.session.id })
            .from(tables.session)
            .where(eq(tables.session.token, token)),
        ),
      )
      .get()?.pendingPasswordHash ?? null
  );
}

const options = {
  appName: "Antigone",
  baseURL: appOrigin.origin,
  basePath: "/api/auth",
  secret,
  database: drizzleAdapter(db, { provider: "sqlite", schema: tables }),
  trustedOrigins: [appOrigin.origin],
  user: {
    additionalFields: {
      passwordChanged: { type: "boolean", defaultValue: false, input: false },
    },
  },
  emailAndPassword: {
    enabled: true,
    disableSignUp: true,
    minPasswordLength: 12,
    maxPasswordLength: 1024,
  },
  session: {
    expiresIn: 86400 * 7,
    // Our operation-specific authorization replaces Better Auth's age check.
    freshAge: 0,
    cookieCache: { enabled: false },
  },
  advanced: {
    useSecureCookies: appOrigin.protocol === "https:",
    cookiePrefix: "antigone",
    ipAddress: { ipAddressHeaders: ["x-antigone-client-ip"] },
  },
  rateLimit: {
    enabled: true,
    storage: "database",
    window: 60,
    max: 60,
    customRules: { "/sign-in/email": { window: 60, max: 10 } },
  },
  disabledPaths: [
    "/sign-up/email",
    "/change-email",
    "/delete-user",
    "/update-user",
    "/request-password-reset",
    "/reset-password",
    "/verify-password",
    "/passkey/generate-register-options",
    "/passkey/verify-registration",
    "/two-factor/disable",
    "/two-factor/get-totp-uri",
  ],
  plugins: [
    twoFactor({
      issuer: "Antigone",
      // TODO: Re-enable TOTP account lockout.
      accountLockout: { enabled: false },
      backupCodeOptions: { storeBackupCodes: "encrypted" },
    }),
    passkey({
      rpID: appOrigin.hostname,
      rpName: "Antigone",
      origin: appOrigin.origin,
      authenticatorSelection: {
        residentKey: "required",
        userVerification: "required",
      },
      registration: {
        afterVerification({ verification }) {
          if (!verification.registrationInfo?.userVerified) {
            throw new APIError("FORBIDDEN", {
              message:
                "Verify your identity with your device PIN or biometrics",
            });
          }
        },
      },
      authentication: {
        afterVerification({ verification }) {
          if (!verification.authenticationInfo.userVerified) {
            throw new APIError("FORBIDDEN", {
              message:
                "Verify your identity with your device PIN or biometrics",
            });
          }
        },
      },
    }),
  ],
  databaseHooks: {
    session: {
      create: {
        async before(session, context) {
          if (
            getPasswordChanged() &&
            !db
              .select({ twoFactorEnabled: tables.user.twoFactorEnabled })
              .from(tables.user)
              .where(eq(tables.user.id, "owner"))
              .get()?.twoFactorEnabled
          ) {
            throw new APIError("FORBIDDEN", {
              message: "Account has no active authenticator",
            });
          }
          if (context?.path === "/sign-in/email" && !getPasswordChanged()) {
            // Only one bootstrap session may own the pending enrollment.
            await context.context.internalAdapter.deleteUserSessions(
              session.userId,
            );
            db.delete(tables.twoFactor)
              .where(
                and(
                  eq(tables.twoFactor.userId, session.userId),
                  eq(tables.twoFactor.verified, false),
                ),
              )
              .run();
            return {
              data: {
                ...session,
                expiresAt: new Date(Date.now() + sensitiveAuthMs),
              },
            };
          }
          if (
            context?.path === "/change-password" ||
            context?.path === "/two-factor/enable" ||
            context?.path === "/two-factor/verify-totp"
          ) {
            const previous = context.context.session;
            if (previous) {
              return {
                data: { ...session, createdAt: previous.session.createdAt },
              };
            }
          }
          return { data: session };
        },
        async after(session, context) {
          if (
            context?.path === "/two-factor/verify-totp" &&
            context.context.session
          ) {
            // Carry the optional enrollment grant across session rotation.
            db.update(tables.sensitiveAuthorization)
              .set({ sessionId: session.id })
              .where(
                and(
                  eq(
                    tables.sensitiveAuthorization.sessionId,
                    context.context.session.session.id,
                  ),
                  eq(tables.sensitiveAuthorization.operation, "add-passkey"),
                ),
              )
              .run();
          }
          if (context?.path === "/sign-in/email" && !getPasswordChanged()) {
            db.insert(tables.sensitiveAuthorization)
              .values({
                sessionId: session.id,
                operation: "create-password",
                expiresAt: session.expiresAt.getTime(),
              })
              .run();
            return;
          }
          // Only completed credential verification can consume a login intent.
          if (
            context?.headers?.get("x-antigone-sensitive-login") === "1" &&
            (context.path === "/passkey/verify-authentication" ||
              ((context.path === "/two-factor/verify-totp" ||
                context.path === "/two-factor/verify-backup-code") &&
                !context.context.session))
          ) {
            const identifier: unknown = await sensitiveIntentCookie.parse(
              context.headers.get("cookie"),
            );
            if (typeof identifier === "string") {
              const intent =
                await context.context.internalAdapter.consumeVerificationValue(
                  identifier,
                );
              if (intent && intent.expiresAt.getTime() > Date.now()) {
                const grant = JSON.parse(
                  intent.value,
                ) as SensitiveAuthorization;
                db.insert(tables.sensitiveAuthorization)
                  .values({
                    sessionId: session.id,
                    operation: grant.operation,
                    target: grant.target,
                    expiresAt: Date.now() + sensitiveAuthMs,
                  })
                  .run();
              }
            }
          }
        },
      },
    },
    user: {
      update: {
        before(user, context) {
          if (
            context?.path === "/two-factor/verify-totp" &&
            user.twoFactorEnabled &&
            !getPasswordChanged()
          ) {
            const active = context.context.session;
            db.transaction((tx) => {
              const password =
                active && getPendingPassword(active.session.token);
              if (!password) {
                throw new APIError("UNAUTHORIZED", {
                  message: "Sign in with INIT_PASSWORD and restart setup",
                });
              }
              requireSensitiveAuthorization(
                active.session.token,
                "init-authenticator",
                null,
              );
              tx.update(tables.sensitiveAuthorization)
                .set({ operation: "add-passkey", pendingPasswordHash: null })
                .where(
                  eq(
                    tables.sensitiveAuthorization.sessionId,
                    active.session.id,
                  ),
                )
                .run();
              // This hook runs only after Better Auth has verified the TOTP.
              // Commit both credentials together, before rotating the session.
              tx.update(tables.account)
                .set({ password, updatedAt: new Date() })
                .where(
                  and(
                    eq(tables.account.userId, "owner"),
                    eq(tables.account.providerId, "credential"),
                  ),
                )
                .run();
              tx.update(tables.user)
                .set({ passwordChanged: true, twoFactorEnabled: true })
                .where(eq(tables.user.id, "owner"))
                .run();
              tx.update(tables.twoFactor)
                .set({ verified: true })
                .where(eq(tables.twoFactor.userId, "owner"))
                .run();
            });
            return Promise.resolve({
              data: { ...user, passwordChanged: true },
            });
          }
          return Promise.resolve({ data: user });
        },
        async after(user, context) {
          if (
            context?.path === "/two-factor/verify-totp" &&
            user.twoFactorEnabled
          ) {
            // Keep the current grant until Better Auth rotates this session.
            const active = context.context.session;
            if (active) {
              db.delete(tables.session)
                .where(
                  and(
                    eq(tables.session.userId, user.id),
                    ne(tables.session.id, active.session.id),
                  ),
                )
                .run();
            } else {
              await context.context.internalAdapter.deleteUserSessions(user.id);
            }
          }
        },
      },
    },
    account: {
      update: {
        // eslint-disable-next-line require-await
        async after(_account, context) {
          if (context?.path === "/change-password") {
            db.update(tables.user)
              .set({ passwordChanged: true })
              .where(eq(tables.user.id, "owner"))
              .run();
          }
        },
      },
    },
  },
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      const body = ctx.body as { [key: string]: unknown } | undefined;
      const active = await getSessionFromCtx(ctx);
      if (
        ctx.path === "/passkey/update-passkey" &&
        active?.user.id !== "owner"
      ) {
        throw new APIError("UNAUTHORIZED", {
          message: "Sign in to rename a passkey",
        });
      }
      const passwordChanged = getPasswordChanged();
      if (active && !passwordChanged) {
        const grant = getSensitiveAuthorization(active.session.token);
        if (!grant || !isSetupAuthorization(grant)) {
          await ctx.context.internalAdapter.deleteSession(active.session.token);
          if (ctx.path === "/get-session") return ctx.json(null);
          throw new APIError("UNAUTHORIZED", {
            message: "Restart initial setup",
          });
        }
        const allowed = [
          "/get-session",
          "/sign-out",
          "/change-password",
          "/two-factor/enable",
          "/two-factor/verify-totp",
        ];
        if (!allowed.includes(ctx.path)) {
          throw new APIError("FORBIDDEN", {
            message: "Complete initial setup first",
          });
        }
      }
      if (passwordChanged && active && !active.user.twoFactorEnabled) {
        await ctx.context.internalAdapter.deleteSession(active.session.token);
        if (ctx.path === "/get-session") return ctx.json(null);
        throw new APIError("UNAUTHORIZED", {
          message: "Account has no active authenticator",
        });
      }
      let operation = sensitivePaths[ctx.path];
      if (
        ctx.path === "/two-factor/verify-totp" &&
        active &&
        (!active.user.twoFactorEnabled ||
          getSensitiveAuthorization(active.session.token)?.operation ===
            "replace-authenticator")
      )
        operation = "replace-authenticator";
      if (!getPasswordChanged()) {
        if (operation === "change-password") operation = "create-password";
        if (operation === "replace-authenticator")
          operation = "init-authenticator";
      }
      if (operation) {
        if (active?.user.id !== "owner") {
          throw new APIError("UNAUTHORIZED", {
            code: "SENSITIVE_AUTH_REQUIRED",
            message: "Sign in to authorize this operation",
          });
        }
        const target =
          operation === "remove-passkey"
            ? typeof body?.id === "string"
              ? body.id
              : null
            : null;
        const grant = requireSensitiveAuthorization(
          active.session.token,
          operation,
          target,
        );
        const preparation =
          ctx.path === "/two-factor/generate-backup-codes" ||
          ctx.path === "/passkey/generate-register-options" ||
          ctx.path === "/two-factor/enable";
        if (
          operation !== "create-password" &&
          operation !== "init-authenticator" &&
          operation !== "replace-authenticator" &&
          !preparation
        ) {
          // Claim once before dispatch so concurrent requests cannot reuse it.
          // Fail closed if the operation fails after it starts.
          const claimed = db
            .delete(tables.sensitiveAuthorization)
            .where(
              and(
                eq(tables.sensitiveAuthorization.sessionId, active.session.id),
                eq(tables.sensitiveAuthorization.operation, grant.operation),
                grant.target === null
                  ? isNull(tables.sensitiveAuthorization.target)
                  : eq(tables.sensitiveAuthorization.target, grant.target),
                eq(tables.sensitiveAuthorization.expiresAt, grant.expiresAt),
              ),
            )
            .returning({ sessionId: tables.sensitiveAuthorization.sessionId })
            .get();
          if (!claimed) {
            throw new APIError("UNAUTHORIZED", {
              code: "SENSITIVE_AUTH_REQUIRED",
              message: "Authorization already used",
            });
          }
        }
      }
      if (ctx.path === "/two-factor/generate-backup-codes" && active) {
        if (ctx.headers?.get("origin") !== appOrigin.origin)
          throw new APIError("FORBIDDEN", { message: "Invalid origin" });
        const grant = requireSensitiveAuthorization(
          active.session.token,
          "generate-recovery-codes",
          null,
        );
        const backupCodes = Array.from({ length: 10 }, () => {
          const code = generateRandomString(10, "a-z", "0-9", "A-Z");
          return `${code.slice(0, 5)}-${code.slice(5)}`;
        });
        const generationId = crypto.randomUUID();
        const encryptedCodes = await symmetricEncrypt({
          key: ctx.context.secretConfig,
          data: JSON.stringify(backupCodes),
        });
        requireSensitiveAuthorization(
          active.session.token,
          "generate-recovery-codes",
          null,
        );
        const saved = db
          .update(tables.sensitiveAuthorization)
          .set({
            pendingRecoveryCodes: JSON.stringify({
              generationId,
              encryptedCodes,
            }),
          })
          .where(
            and(
              eq(tables.sensitiveAuthorization.sessionId, active.session.id),
              eq(
                tables.sensitiveAuthorization.operation,
                "generate-recovery-codes",
              ),
              eq(tables.sensitiveAuthorization.expiresAt, grant.expiresAt),
            ),
          )
          .returning({ sessionId: tables.sensitiveAuthorization.sessionId })
          .all();
        if (!saved.length) {
          throw new APIError("UNAUTHORIZED", {
            code: "SENSITIVE_AUTH_REQUIRED",
            message: "Authorization expired",
          });
        }
        return ctx.json({ backupCodes, generationId });
      }
      if (operation === "replace-authenticator" && active) {
        // Keep the active credentials until verification commits the swap.
        if (ctx.headers?.get("origin") !== appOrigin.origin)
          throw new APIError("FORBIDDEN", { message: "Invalid origin" });
        const { token } = active.session;
        const grant = requireSensitiveAuthorization(
          token,
          "replace-authenticator",
          null,
        );
        if (ctx.path === "/two-factor/enable") {
          const newSecret = generateRandomString(32);
          const backupCodes = Array.from({ length: 10 }, () => {
            const code = generateRandomString(10, "a-z", "0-9", "A-Z");
            return `${code.slice(0, 5)}-${code.slice(5)}`;
          });
          const encryptedPending = JSON.stringify({
            secret: await symmetricEncrypt({
              key: ctx.context.secretConfig,
              data: newSecret,
            }),
            backupCodes: await symmetricEncrypt({
              key: ctx.context.secretConfig,
              data: JSON.stringify(backupCodes),
            }),
          });
          requireSensitiveAuthorization(token, "replace-authenticator", null);
          const saved = db
            .update(tables.sensitiveAuthorization)
            .set({ pendingAuthenticator: encryptedPending })
            .where(
              and(
                eq(tables.sensitiveAuthorization.sessionId, active.session.id),
                eq(tables.sensitiveAuthorization.operation, grant.operation),
                isNull(tables.sensitiveAuthorization.target),
                eq(tables.sensitiveAuthorization.expiresAt, grant.expiresAt),
              ),
            )
            .returning({ sessionId: tables.sensitiveAuthorization.sessionId })
            .all();
          if (!saved.length)
            throw new APIError("UNAUTHORIZED", { message: "Session expired" });
          return ctx.json({
            method: "totp",
            totpURI: createOTP(newSecret).url("Antigone", active.user.email),
            backupCodes,
          });
        }
        const pending = db
          .select({
            pendingAuthenticator:
              tables.sensitiveAuthorization.pendingAuthenticator,
          })
          .from(tables.sensitiveAuthorization)
          .where(eq(tables.sensitiveAuthorization.sessionId, active.session.id))
          .get()?.pendingAuthenticator;
        if (!pending) {
          throw new APIError("BAD_REQUEST", {
            message: "Start authenticator replacement first",
          });
        }
        const replacement = JSON.parse(pending) as {
          secret: string;
          backupCodes: string;
        };
        const totpSecret = await symmetricDecrypt({
          key: ctx.context.secretConfig,
          data: replacement.secret,
        });
        if (
          typeof body?.code !== "string" ||
          !/^\d{6}$/u.test(body.code) ||
          !(await createOTP(totpSecret).verify(body.code))
        ) {
          throw new APIError("BAD_REQUEST", {
            message: "Invalid authenticator code",
          });
        }
        db.transaction((tx) => {
          requireSensitiveAuthorization(token, "replace-authenticator", null);
          const claimed = tx
            .delete(tables.sensitiveAuthorization)
            .where(
              and(
                eq(tables.sensitiveAuthorization.sessionId, active.session.id),
                eq(tables.sensitiveAuthorization.operation, grant.operation),
                isNull(tables.sensitiveAuthorization.target),
                eq(tables.sensitiveAuthorization.expiresAt, grant.expiresAt),
                eq(tables.sensitiveAuthorization.pendingAuthenticator, pending),
              ),
            )
            .returning({ sessionId: tables.sensitiveAuthorization.sessionId })
            .get();
          if (!claimed) {
            throw new APIError("UNAUTHORIZED", {
              message: "Authorization already used",
            });
          }
          const updated = tx
            .update(tables.twoFactor)
            .set({
              secret: replacement.secret,
              backupCodes: replacement.backupCodes,
              verified: true,
            })
            .where(
              and(
                eq(tables.twoFactor.userId, "owner"),
                eq(tables.twoFactor.verified, true),
              ),
            )
            .returning({ id: tables.twoFactor.id })
            .all();
          if (!updated.length) {
            throw new APIError("FORBIDDEN", {
              message: "Active authenticator missing",
            });
          }
          tx.delete(tables.session)
            .where(
              and(
                eq(tables.session.userId, "owner"),
                ne(tables.session.token, token),
              ),
            )
            .run();
        });
        return ctx.json({ status: true });
      }
      if (ctx.path === "/change-password") {
        if (!getPasswordChanged()) {
          if (ctx.headers?.get("origin") !== appOrigin.origin)
            throw new APIError("FORBIDDEN", { message: "Invalid origin" });

          const session = await getSessionFromCtx(ctx);
          const password = body?.newPassword;
          if (
            typeof password !== "string" ||
            password.length < 12 ||
            password.length > 1024 ||
            password === process.env.INIT_PASSWORD
          ) {
            throw new APIError("BAD_REQUEST", {
              message:
                "Choose a different password between 12 and 1024 characters",
            });
          }
          const hash = await ctx.context.password.hash(password);
          if (!session) {
            throw new APIError("UNAUTHORIZED", {
              message: "Sign in with INIT_PASSWORD and restart setup",
            });
          }
          const grant = requireSensitiveAuthorization(
            session.session.token,
            "create-password",
            null,
          );
          const updated = db
            .update(tables.sensitiveAuthorization)
            .set({ pendingPasswordHash: hash, operation: "init-authenticator" })
            .where(
              and(
                eq(tables.sensitiveAuthorization.sessionId, session.session.id),
                eq(tables.sensitiveAuthorization.operation, grant.operation),
                isNull(tables.sensitiveAuthorization.target),
                eq(tables.sensitiveAuthorization.expiresAt, grant.expiresAt),
              ),
            )
            .returning({ sessionId: tables.sensitiveAuthorization.sessionId })
            .all();
          if (!updated.length)
            throw new APIError("UNAUTHORIZED", { message: "Session expired" });
          return ctx.json({ token: null, user: session.user });
        }
        if (body) body.revokeOtherSessions = true;
      }
      if (body && Object.hasOwn(body, "trustDevice")) body.trustDevice = false;
      if (ctx.path === "/two-factor/enable" && !getPasswordChanged()) {
        const session = await getSessionFromCtx(ctx);
        if (!session || !getPendingPassword(session.session.token)) {
          throw new APIError("FORBIDDEN", {
            message: "Choose your new password first",
          });
        }
        if (body) body.password = process.env.INIT_PASSWORD!;
      }
      if (
        ctx.path === "/passkey/generate-register-options" ||
        ctx.path === "/passkey/verify-registration"
      ) {
        const session = await getSessionFromCtx(ctx);
        if (!session?.user.twoFactorEnabled || !getPasswordChanged()) {
          throw new APIError("FORBIDDEN", {
            message: "Set a password and enable your authenticator first",
          });
        }
      }
      if (body && ctx.path === "/change-password" && getPasswordChanged()) {
        // The fresh owner session authorizes these password-gated endpoints.
        // Scope verification to this request, account, and generated value.
        const account =
          await ctx.context.internalAdapter.findCredentialAccount("owner");
        if (!account?.password) {
          throw new APIError("FORBIDDEN", {
            message: "Password account missing",
          });
        }
        const authorization = crypto.randomUUID();
        body.currentPassword = authorization;
        return {
          context: {
            context: {
              password: {
                ...ctx.context.password,
                verify({ hash, password }: { hash: string; password: string }) {
                  return Promise.resolve(
                    hash === account.password && password === authorization,
                  );
                },
              },
            },
          },
        };
      }
      return undefined;
    }),
    after: createAuthMiddleware(async (ctx) => {
      const result = ctx.context.returned;
      if (!result || typeof result !== "object" || result instanceof APIError)
        return undefined;
      if (
        ctx.path === "/passkey/generate-authenticate-options" &&
        Object.hasOwn(result, "challenge")
      )
        return await ctx.json({ ...result, userVerification: "required" });
      return undefined;
    }),
  },
} satisfies BetterAuthOptions;

const ready = initializeAuthDatabase().then(() => betterAuth(options));

export async function registerPasskey(request: Request): Promise<Response> {
  requireSameOrigin(request);
  const parsed: unknown = await request.json().catch(() => null);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return Response.json(
      { message: "Invalid registration request" },
      { status: 400 },
    );
  }
  const input = parsed as { [key: string]: unknown };
  const auth = await ready;
  if (input.intent === "options") {
    const optionsResponse = await auth.api.generatePasskeyRegistrationOptions({
      headers: request.headers,
      query: { name: "owner" },
      asResponse: true,
    });
    if (!optionsResponse.ok) return optionsResponse;
    const registrationOptions =
      (await optionsResponse.json()) as PublicKeyCredentialCreationOptionsJSON;
    // WebAuthn account identity is independent of the saved credential label.
    registrationOptions.user.name = "owner";
    registrationOptions.user.displayName = "owner";
    return Response.json(registrationOptions, {
      headers: optionsResponse.headers,
    });
  }
  if (
    input.intent !== "register" ||
    typeof input.name !== "string" ||
    !input.name.trim() ||
    !input.response ||
    typeof input.response !== "object"
  ) {
    return Response.json(
      { message: "Invalid registration request" },
      { status: 400 },
    );
  }
  // Better Auth verifies the challenge and saves the label with the credential
  // in one operation. Existing hooks enforce and consume the add-passkey grant.
  const response = await auth.api.verifyPasskeyRegistration({
    headers: request.headers,
    body: { response: input.response, name: input.name.trim() },
    asResponse: true,
  });
  if (!response.ok) return response;
  return Response.json({ ok: true }, { headers: response.headers });
}

export async function beginSensitiveLogin(request: Request): Promise<Response> {
  if (
    request.method !== "POST" ||
    request.headers.get("Origin") !== appOrigin.origin
  )
    return new Response("Invalid request", { status: 403 });
  const state = await requireOwnerSession(request);
  const form = await request.formData();
  const operation = form.get("operation");
  const target = form.get("target");
  if (
    typeof operation !== "string" ||
    !Object.values(sensitivePaths).includes(operation as SensitiveOperation)
  )
    return new Response("Unknown operation", { status: 400 });
  const targetsPasskey = operation === "remove-passkey";
  if (
    targetsPasskey &&
    (typeof target !== "string" ||
      !state.passkeys.some((key) => key.id === target))
  )
    return new Response("Unknown passkey", { status: 400 });
  const intent: SensitiveAuthorization = {
    operation: operation as SensitiveOperation,
    target: targetsPasskey ? (target as string) : null,
    expiresAt: Date.now() + sensitiveAuthMs,
  };
  const auth = await ready;
  const context = await auth.$context;
  const identifier = `sensitive-${crypto.randomUUID()}`;
  await context.internalAdapter.createVerificationValue({
    identifier,
    value: JSON.stringify(intent),
    expiresAt: new Date(intent.expiresAt),
  });
  // A credential login must not reuse the existing session for its MFA step.
  const response = await auth.api.signOut({
    headers: request.headers,
    asResponse: true,
  });
  if (!response.ok) return response;
  const headers = new Headers(response.headers);
  headers.append(
    "Set-Cookie",
    await sensitiveIntentCookie.serialize(identifier),
  );
  return redirect("/auth/login?sensitive=1&redirectTo=%2Fauth%2Fmanage", {
    status: 303,
    headers,
  });
}

export async function confirmRecoveryCodes(
  request: Request,
): Promise<Response> {
  if (
    request.method !== "POST" ||
    request.headers.get("Origin") !== appOrigin.origin
  ) {
    return Response.json(
      { error: { message: "Invalid request" } },
      { status: 403 },
    );
  }
  const auth = await ready;
  const active = await auth.api.getSession({ headers: request.headers });
  const grant =
    active?.user.id === "owner"
      ? getSensitiveAuthorization(active.session.token)
      : null;
  if (
    !active ||
    !active.user.twoFactorEnabled ||
    !getPasswordChanged() ||
    grant?.operation !== "generate-recovery-codes"
  ) {
    return Response.json(
      {
        error: {
          code: "SENSITIVE_AUTH_REQUIRED",
          message: "Verify your identity again",
        },
      },
      { status: 401 },
    );
  }
  const form = await request.formData();
  const generationId = form.get("generationId");
  const confirmed = db.transaction((tx) => {
    const row = tx
      .select()
      .from(tables.sensitiveAuthorization)
      .where(
        and(
          eq(tables.sensitiveAuthorization.sessionId, active.session.id),
          eq(
            tables.sensitiveAuthorization.operation,
            "generate-recovery-codes",
          ),
        ),
      )
      .get();
    if (!row?.pendingRecoveryCodes || row.expiresAt <= Date.now()) return false;
    const pending = JSON.parse(row.pendingRecoveryCodes) as {
      generationId: string;
      encryptedCodes: string;
    };
    if (pending.generationId !== generationId) return false;
    const updated = tx
      .update(tables.twoFactor)
      .set({ backupCodes: pending.encryptedCodes })
      .where(
        and(
          eq(tables.twoFactor.userId, "owner"),
          eq(tables.twoFactor.verified, true),
        ),
      )
      .returning({ id: tables.twoFactor.id })
      .all();
    if (!updated.length) return false;
    tx.delete(tables.sensitiveAuthorization)
      .where(eq(tables.sensitiveAuthorization.sessionId, active.session.id))
      .run();
    return true;
  });
  return confirmed
    ? Response.json({ error: null })
    : Response.json(
        {
          error: {
            message:
              "These pending codes have expired or been replaced. Generate and save new codes.",
          },
        },
        { status: 409 },
      );
}

export async function skipOnboardingPasskey(
  request: Request,
): Promise<Response> {
  if (
    request.method !== "POST" ||
    request.headers.get("Origin") !== appOrigin.origin
  )
    return new Response("Invalid request", { status: 403 });
  const form = await request.formData();
  if (form.get("intent") !== "skip-passkey")
    return new Response("Unknown operation", { status: 400 });
  const auth = await ready;
  const active = await auth.api.getSession({ headers: request.headers });
  if (active?.user.id !== "owner") return redirect("/auth/login");
  if (!getPasswordChanged() || !active.user.twoFactorEnabled)
    return redirect("/auth/onboard");
  db.delete(tables.sensitiveAuthorization)
    .where(
      and(
        eq(tables.sensitiveAuthorization.sessionId, active.session.id),
        eq(tables.sensitiveAuthorization.operation, "add-passkey"),
      ),
    )
    .run();
  return redirect("/auth/manage", { status: 303 });
}

export async function getSensitiveLoginIntent(
  request: Request,
): Promise<SensitiveAuthorization | null> {
  if (new URL(request.url).searchParams.get("sensitive") !== "1") return null;
  const identifier: unknown = await sensitiveIntentCookie.parse(
    request.headers.get("Cookie"),
  );
  if (typeof identifier !== "string") return null;
  const auth = await ready;
  const context = await auth.$context;
  const intent =
    await context.internalAdapter.findVerificationValue(identifier);
  if (!intent || intent.expiresAt.getTime() <= Date.now()) return null;
  return JSON.parse(intent.value) as SensitiveAuthorization;
}

export async function authHandler(request: Request): Promise<Response> {
  if (new URL(request.url).host !== appOrigin.host)
    return new Response("Unknown host", { status: 400 });
  const auth = await ready;
  if (request.headers.get("x-antigone-sensitive-login") === "1") {
    // Sensitive sign-in must verify a fresh second factor even on a trusted
    // device. Normal sign-in keeps Better Auth's usual cookie handling.
    const context = await auth.$context;
    const trustCookie = context.createAuthCookie("trust_device").name;
    request.headers.set(
      "Cookie",
      (request.headers.get("Cookie") ?? "")
        .split(";")
        .filter((cookie) => cookie.trim().split("=", 1)[0] !== trustCookie)
        .join(";"),
    );
  }
  const response = await auth.handler(request);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export interface AuthState {
  status:
    | "uninitialized"
    | "unauthenticated"
    | "authenticated"
    | SensitiveAuthorization;
  passkeys: { id: string; name: string; createdAt: Date }[];
}

export async function getAuthState(request: Request): Promise<AuthState> {
  const auth = await ready;
  const passwordUnchanged = !getPasswordChanged();
  const passkeys = db
    .select({
      id: tables.passkey.id,
      name: tables.passkey.name,
      createdAt: tables.passkey.createdAt,
    })
    .from(tables.passkey)
    .where(eq(tables.passkey.userId, "owner"))
    .all()
    .map(({ id, name, createdAt }) => ({
      id,
      name: name ?? "No ID",
      createdAt: createdAt ?? new Date(0),
    }));
  const session = await auth.api.getSession({ headers: request.headers });
  const ownerSession = session?.user.id === "owner" ? session : null;
  if (!ownerSession) {
    return {
      status: passwordUnchanged ? "uninitialized" : "unauthenticated",
      passkeys,
    };
  }
  const grant = getSensitiveAuthorization(ownerSession.session.token);
  if (!passwordUnchanged && !ownerSession.user.twoFactorEnabled) {
    const context = await auth.$context;
    await context.internalAdapter.deleteSession(ownerSession.session.token);
    return { status: "unauthenticated", passkeys };
  }
  if (
    passwordUnchanged &&
    grant?.operation !== "create-password" &&
    grant?.operation !== "init-authenticator"
  ) {
    const context = await auth.$context;
    await context.internalAdapter.deleteSession(ownerSession.session.token);
    db.delete(tables.twoFactor)
      .where(
        and(
          eq(tables.twoFactor.userId, "owner"),
          eq(tables.twoFactor.verified, false),
        ),
      )
      .run();
    return { status: "uninitialized", passkeys };
  }
  return { status: grant ?? "authenticated", passkeys };
}

export async function requireOwnerSession(
  request: Request,
): Promise<AuthState> {
  const state = await getAuthState(request);
  if (isSetupAuthorization(state.status)) throw redirect("/auth/onboard");
  if (state.status === "unauthenticated" || state.status === "uninitialized") {
    throw redirect(
      new URL(request.url).pathname === "/auth/manage"
        ? "/auth/login?redirectTo=%2Fauth%2Fmanage"
        : "/auth/login",
    );
  }
  return state;
}

export async function logout(request: Request): Promise<Response> {
  if (
    request.method !== "POST" ||
    request.headers.get("Origin") !== appOrigin.origin
  )
    return new Response("Invalid request", { status: 403 });
  const auth = await ready;
  const response = await auth.api.signOut({
    headers: request.headers,
    asResponse: true,
  });
  if (!response.ok) return response;
  return redirect("/auth/login", { status: 303, headers: response.headers });
}
