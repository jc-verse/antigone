import { type ReactElement, useState } from "react";
import { useLoaderData } from "@remix-run/react";
import type { loader } from "./route";
import { authClient, ifErrorThrow } from "../../ui/auth/auth-utils";
import styles from "./Login.module.css";

function TwoFAForm({
  perform,
  busy,
}: {
  readonly perform: (work: () => Promise<void>) => Promise<void>;
  readonly busy: boolean;
}) {
  const { redirectTo, sensitiveIntent } = useLoaderData<typeof loader>();
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState(false);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void perform(async () => {
          const verifier = recovery
            ? authClient.twoFactor.verifyBackupCode
            : authClient.twoFactor.verifyTotp;
          const result = await verifier(
            { code, trustDevice: false },
            {
              headers: sensitiveIntent
                ? { "x-antigone-sensitive-login": "1" }
                : {},
            },
          );
          ifErrorThrow(result);
          window.location.assign(redirectTo);
        });
      }}>
      <label>
        {recovery ? "Recovery code" : "Authenticator code"}
        <input
          type="text"
          autoComplete="one-time-code"
          inputMode={recovery ? "text" : "numeric"}
          pattern={recovery ? undefined : "[0-9]{6}"}
          required
          value={code}
          onChange={(event) => setCode(event.target.value)}
        />
      </label>
      <div className={styles.loginActions}>
        <button className={styles.primary} disabled={busy} type="submit">
          Verify
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setRecovery(!recovery);
            setCode("");
          }}>
          {recovery ? "Use authenticator app" : "Use a recovery code"}
        </button>
      </div>
    </form>
  );
}

function PasswordForm({
  perform,
  setTwoFactorRequired,
  busy,
}: {
  readonly perform: (work: () => Promise<void>) => Promise<void>;
  readonly setTwoFactorRequired: (state: boolean) => void;
  readonly busy: boolean;
}) {
  const { redirectTo, sensitiveIntent } = useLoaderData<typeof loader>();
  const [password, setPassword] = useState("");
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void perform(async () => {
          const result = await authClient.signIn.email(
            { email: "owner@antigone.invalid", password },
            {
              headers: sensitiveIntent
                ? { "x-antigone-sensitive-login": "1" }
                : {},
            },
          );
          ifErrorThrow(result);
          if (
            (result.data as { twoFactorRedirect?: boolean }).twoFactorRedirect
          ) {
            setTwoFactorRequired(true);
          } else if (sensitiveIntent) {
            throw new Error(
              "Second-factor verification is required. Restart sign-in.",
            );
          } else {
            window.location.assign(redirectTo);
          }
        });
      }}>
      <label>
        Password{" "}
        <input
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </label>
      <div className={styles.loginActions}>
        <button className={styles.primary} type="submit" disabled={busy}>
          Sign in
        </button>
      </div>
    </form>
  );
}

export default function Login(): ReactElement {
  const { initialSetup, hasPasskey, redirectTo, sensitiveIntent } =
    useLoaderData<typeof loader>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [twoFactorRequired, setTwoFactorRequired] = useState(false);
  async function perform(work: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Sign-in failed");
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className={styles.login}>
      <h1>{sensitiveIntent ? "Confirm your identity" : "Sign in"}</h1>
      {sensitiveIntent && (
        <p>
          This verification authorizes only{" "}
          {sensitiveIntent.operation.replaceAll("-", " ")} for up to 15 minutes.
        </p>
      )}
      {initialSetup && (
        <p>
          Welcome to Antigone! Sign in with your initial password (the{" "}
          <code>INIT_PASSWORD</code> environment) to set up your account.
        </p>
      )}
      {twoFactorRequired ? (
        <TwoFAForm perform={perform} busy={busy} />
      ) : (
        <PasswordForm
          perform={perform}
          setTwoFactorRequired={setTwoFactorRequired}
          busy={busy}
        />
      )}
      {hasPasskey && (
        <div className={styles.loginActions}>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              void perform(async () => {
                const result = await authClient.signIn.passkey({
                  fetchOptions: {
                    headers: sensitiveIntent
                      ? { "x-antigone-sensitive-login": "1" }
                      : {},
                  },
                });
                ifErrorThrow(result);
                window.location.assign(redirectTo);
              });
            }}>
            Sign in with a passkey
          </button>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </main>
  );
}
