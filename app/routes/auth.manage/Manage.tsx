import { type ReactElement, useState } from "react";
import { Form, useLoaderData } from "@remix-run/react";
import type { loader } from "./route";
import useAuthManagement from "./useAuthManagement";
import AuthenticatorSetup from "../../ui/auth/AuthenticatorSetup";
import styles from "./Manage.module.css";

export default function Manage(): ReactElement {
  const { passkeys, status } = useLoaderData<typeof loader>();
  const {
    busy,
    error,
    changePassword,
    recoveryCodes,
    regenerateRecoveryCodes,
    confirmRecoveryCodes,
    addPasskey,
    removePasskey,
  } = useAuthManagement(typeof status === "object" ? status : null);
  const [passkeyName, setPasskeyName] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  return (
    <main className={styles.manage}>
      <h1>Authentication</h1>
      <section aria-labelledby="manage-password-heading">
        <h2 id="manage-password-heading">Password</h2>
        {typeof status === "object" &&
        status.operation === "change-password" ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void changePassword(newPassword, confirmation);
            }}>
            <label>
              New password{" "}
              <input
                type="password"
                autoComplete="new-password"
                required
                minLength={12}
                maxLength={1024}
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
              />
            </label>
            <label>
              Confirm new password{" "}
              <input
                type="password"
                autoComplete="new-password"
                required
                minLength={12}
                maxLength={1024}
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
              />
            </label>
            <div className={styles.actions}>
              <button type="submit" disabled={busy}>
                Save new password
              </button>
            </div>
          </form>
        ) : (
          <Form method="post">
            <input type="hidden" name="operation" value="change-password" />
            <div className={styles.actions}>
              <button type="submit" disabled={busy}>
                Change password
              </button>
            </div>
          </Form>
        )}
      </section>
      <section aria-labelledby="manage-authenticator-heading">
        <h2 id="manage-authenticator-heading">Authenticator</h2>
        {typeof status === "object" &&
        status.operation === "replace-authenticator" ? (
          <AuthenticatorSetup mode="replacement" />
        ) : (
          <Form method="post">
            <input
              type="hidden"
              name="operation"
              value="replace-authenticator"
            />
            <div className={styles.actions}>
              <button type="submit" disabled={busy}>
                Replace authenticator
              </button>
            </div>
          </Form>
        )}
      </section>
      <section aria-labelledby="recovery-heading">
        <h2 id="recovery-heading">Recovery codes</h2>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void regenerateRecoveryCodes();
          }}>
          <div className={styles.actions}>
            <button type="submit" disabled={busy}>
              Generate new recovery codes
            </button>
          </div>
        </form>
      </section>
      {recoveryCodes.length > 0 && (
        <section aria-labelledby="save-codes-heading">
          <h2 id="save-codes-heading">Save your recovery codes</h2>
          <p>
            Store these somewhere safe. Each code replaces an authenticator code
            once; you still need your password.
          </p>
          <pre className={styles.recoveryCodes}>{recoveryCodes.join("\n")}</pre>
          <a
            download="antigone-recovery-codes.txt"
            href={`data:text/plain;charset=utf-8,${encodeURIComponent(
              recoveryCodes.join("\n"),
            )}`}>
            Download recovery codes
          </a>
          <div className={styles.actions}>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                void confirmRecoveryCodes();
              }}>
              I have saved these codes
            </button>
          </div>
        </section>
      )}
      {(passkeys.length > 0 || recoveryCodes.length === 0) && (
        <section
          className={styles.passkeyList}
          aria-labelledby="passkeys-heading">
          <h2 id="passkeys-heading">Passkeys</h2>
          {passkeys.length > 0 && (
            <ul>
              {passkeys.map((passkey) => (
                <li key={passkey.id}>
                  <span>{passkey.name}</span>
                  <small>
                    Added{" "}
                    {new Date(passkey.createdAt).toLocaleDateString("en-US")}
                  </small>
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={`Remove ${passkey.name}`}
                    onClick={() => {
                      void removePasskey(passkey.id);
                    }}>
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
          {recoveryCodes.length === 0 && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void addPasskey(passkeyName);
              }}>
              <label>
                Passkey name{" "}
                <input
                  type="text"
                  placeholder="e.g. Laptop"
                  value={passkeyName}
                  onChange={(event) => setPasskeyName(event.target.value)}
                />
              </label>
              <div className={styles.actions}>
                <button
                  className={styles.primary}
                  type="submit"
                  disabled={busy}>
                  {passkeys.length ? "Add passkey" : "Register passkey"}
                </button>
              </div>
            </form>
          )}
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
