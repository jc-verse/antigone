import { createAuthClient } from "better-auth/react";
import { twoFactorClient } from "better-auth/client/plugins";
import { passkeyClient } from "@better-auth/passkey/client";
import {
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
} from "@simplewebauthn/browser";
import QRCode from "qrcode";

export const authClient = createAuthClient({
  plugins: [twoFactorClient(), passkeyClient()],
});

class AuthError extends Error {
  details: unknown;
  constructor(error: { message?: string | undefined }) {
    super(error.message);
    this.details = error;
  }
}

export async function registerPasskey(name: string): Promise<void> {
  async function submit(body: object): Promise<Response> {
    const response = await fetch("/auth/passkey", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const error = (await response.json()) as { message?: string };
      throw new AuthError(error);
    }
    return response;
  }
  const optionsResponse = await submit({ intent: "options" });
  const options =
    (await optionsResponse.json()) as PublicKeyCredentialCreationOptionsJSON;
  const credential = await startRegistration({ optionsJSON: options });
  await submit({
    intent: "register",
    name: name.trim() || "Passkey",
    response: credential,
  });
}

export function ifErrorThrow<
  T extends { error: { message?: string | undefined } | null },
>(result: T): asserts result is Extract<T, { error: null }> {
  if (result.error) throw new AuthError(result.error);
}

export interface AuthenticatorEnrollment {
  secret: string;
  qr: string;
  backupCodes: string[];
}

export async function startAuthenticator(): Promise<AuthenticatorEnrollment> {
  const result = await authClient.twoFactor.enable({ password: "" });
  ifErrorThrow(result);
  if (result.data.method !== "totp")
    throw new Error("Could not start authenticator setup");
  return {
    secret: new URL(result.data.totpURI).searchParams.get("secret") ?? "",
    qr: await QRCode.toDataURL(result.data.totpURI),
    backupCodes: result.data.backupCodes,
  };
}
