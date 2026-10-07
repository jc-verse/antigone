export type SensitiveOperation =
  | "create-password"
  | "init-authenticator"
  | "change-password"
  | "replace-authenticator"
  | "generate-recovery-codes"
  | "add-passkey"
  | "remove-passkey";

export interface SensitiveAuthorization {
  operation: SensitiveOperation;
  target: string | null;
  expiresAt: number;
}

export function isSetupAuthorization(
  status: string | SensitiveAuthorization,
): status is SensitiveAuthorization & {
  operation: "create-password" | "init-authenticator";
} {
  return (
    typeof status === "object" &&
    (status.operation === "create-password" ||
      status.operation === "init-authenticator")
  );
}
