import { type ReactElement, useState } from "react";
import { Form, useLoaderData } from "@remix-run/react";
import type { loader } from "./route";

import AuthenticatorSetup from "../../ui/auth/AuthenticatorSetup";
import {
  authClient,
  registerPasskey,
  ifErrorThrow,
  startAuthenticator,
  type AuthenticatorEnrollment,
} from "../../ui/auth/auth-utils";
import styles from "./Onboard.module.css";

export default function Onboard(): ReactElement {
  const { status: initialStatus } = useLoaderData<typeof loader>();
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [passkeyName, setPasskeyName] = useState("");
  const [status, setStatus] = useState(initialStatus);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [initialEnrollment, setInitialEnrollment] =
    useState<AuthenticatorEnrollment | null>(null);
  async function perform(work: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (cause) {
      if (
        (cause as { details?: { code?: string } } | null)?.details?.code ===
        "SENSITIVE_AUTH_REQUIRED"
      ) {
        window.location.assign("/auth/login");
        return;
      }
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not update authentication",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className={styles.manage}>
      <h1>Set up your account</h1>
      {(status.operation === "create-password" ||
        status.operation === "init-authenticator") && (
        <>
          <p>
            Let's make your account more secure. Choose a new password and set
            up two-factor authentication (2FA), then optionally register a
            passkey.
          </p>
          <p>
            For maximum protection, you must complete onboarding within 15
            minutes after signing in. If the time limit is reached before you
            complete 2FA registration, you must start all over again.
          </p>
        </>
      )}
      {status.operation === "create-password" && (
        <section aria-labelledby="password-heading">
          <h2 id="password-heading">1. Replace the initial password</h2>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void perform(async () => {
                if (newPassword !== confirmation)
                  throw new Error("Passwords do not match");
                const result = await authClient.changePassword({
                  currentPassword: "",
                  newPassword,
                  revokeOtherSessions: true,
                });
                ifErrorThrow(result);
                try {
                  await startAuthenticator().then(setInitialEnrollment);
                } finally {
                  setStatus({ ...status, operation: "init-authenticator" });
                }
              });
            }}>
            <label>
              New password{" "}
              <input
                type="password"
                autoComplete="new-password"
                minLength={12}
                maxLength={1024}
                required
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
              />
            </label>
            <label>
              Confirm new password{" "}
              <input
                type="password"
                autoComplete="new-password"
                minLength={12}
                maxLength={1024}
                required
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
              />
            </label>
            <div className={styles.actions}>
              <button type="submit" className={styles.primary} disabled={busy}>
                Continue to authenticator setup
              </button>
            </div>
          </form>
        </section>
      )}
      {status.operation === "init-authenticator" && (
        <AuthenticatorSetup
          mode="onboarding"
          initialEnrollment={initialEnrollment}
        />
      )}
      {status.operation === "add-passkey" && (
        <section aria-labelledby="passkey-heading">
          <h2 id="passkey-heading">Register a passkey (optional)</h2>
          <p>
            Use a passkey to sign in instead of your password and authenticator.
            You can also add one later in authentication settings.
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void perform(async () => {
                await registerPasskey(passkeyName);
                window.location.assign("/create");
              });
            }}>
            <label>
              Passkey name{" "}
              <input
                type="text"
                value={passkeyName}
                placeholder="e.g. Laptop"
                onChange={(event) => setPasskeyName(event.target.value)}
              />
            </label>
            <div className={styles.actions}>
              <button type="submit" className={styles.primary} disabled={busy}>
                Register passkey
              </button>
            </div>
          </form>
          <Form method="post">
            <button
              type="submit"
              name="intent"
              value="skip-passkey"
              disabled={busy}>
              Skip for now
            </button>
          </Form>
        </section>
      )}
      <div className={styles.actions}>
        <Form method="post" action="/auth/logout">
          <button type="submit">Sign out</button>
        </Form>
      </div>
      {error && <p role="alert">{error}</p>}
    </main>
  );
}
