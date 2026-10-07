import { type ReactElement, useState } from "react";
import { useSubmit } from "@remix-run/react";
import {
  authClient,
  ifErrorThrow,
  startAuthenticator,
  type AuthenticatorEnrollment,
} from "./auth-utils";
import styles from "./AuthenticatorSetup.module.css";

export default function AuthenticatorSetup({
  mode,
  initialEnrollment = null,
}: {
  readonly mode: "onboarding" | "replacement";
  readonly initialEnrollment?: AuthenticatorEnrollment | null;
}): ReactElement {
  const submit = useSubmit();
  const [code, setCode] = useState("");
  const [codesSaved, setCodesSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [authenticator, setAuthenticator] = useState(initialEnrollment);
  const recoveryCodes = authenticator?.backupCodes ?? [];
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
        if (mode === "replacement") {
          submit(
            { operation: "replace-authenticator" },
            { method: "post", action: "/auth/manage" },
          );
        } else {
          window.location.assign("/auth/login");
        }
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
    <div className={styles.setup}>
      <section aria-labelledby="authenticator-heading">
        <h2 id="authenticator-heading">Set up your authenticator</h2>
        {authenticator ? (
          <>
            <p>
              Scan this code in your authenticator app, or enter the setup key
              manually.
            </p>
            <img
              className={styles.qr}
              src={authenticator.qr}
              alt="Authenticator setup QR code"
              width="240"
              height="240"
            />
            <code className={styles.setupKey}>{authenticator.secret}</code>
          </>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              setCodesSaved(false);
              void perform(() => startAuthenticator().then(setAuthenticator));
            }}>
            <div className={styles.actions}>
              <button type="submit" disabled={busy}>
                Set up authenticator app
              </button>
            </div>
          </form>
        )}
      </section>
      {recoveryCodes.length > 0 && (
        <section aria-labelledby="save-codes-heading">
          <h2 id="save-codes-heading">Save your recovery codes</h2>
          <p>
            Store these somewhere safe. Each code replaces an authenticator code
            once. If you lost both your 2FA method and your recovery codes, and
            you don't have a passkey either, you will lose access to your
            account.
          </p>
          <pre className={styles.recoveryCodes}>{recoveryCodes.join("\n")}</pre>
          <a
            download="antigone-recovery-codes.txt"
            href={`data:text/plain;charset=utf-8,${encodeURIComponent(
              recoveryCodes.join("\n"),
            )}`}>
            Download recovery codes
          </a>
          <label className={styles.checkbox}>
            <input
              type="checkbox"
              checked={codesSaved}
              onChange={(event) => setCodesSaved(event.target.checked)}
            />{" "}
            I have saved my recovery codes
          </label>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void perform(async () => {
                const result = await authClient.twoFactor.verifyTotp({
                  code,
                  trustDevice: false,
                });
                ifErrorThrow(result);
                window.location.assign(
                  mode === "onboarding" ? "/auth/onboard" : "/auth/manage",
                );
              });
            }}>
            <label>
              Authenticator code{" "}
              <input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                required
                value={code}
                onChange={(event) => setCode(event.target.value)}
              />
            </label>
            <div className={styles.actions}>
              <button
                className={styles.primary}
                type="submit"
                disabled={busy || !codesSaved}>
                Verify and continue
              </button>
            </div>
          </form>
        </section>
      )}

      {error && <p role="alert">{error}</p>}
    </div>
  );
}
