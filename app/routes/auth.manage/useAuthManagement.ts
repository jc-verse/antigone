import { useState } from "react";
import { useSubmit } from "@remix-run/react";
import {
  authClient,
  ifErrorThrow,
  registerPasskey,
} from "../../ui/auth/auth-utils";
import type {
  SensitiveAuthorization,
  SensitiveOperation,
} from "../../services/auth/sensitive-authorization";

export default function useAuthManagement(
  initialAuthorization: SensitiveAuthorization | null,
): {
  busy: boolean;
  error: string;
  changePassword: (password: string, confirmation: string) => Promise<void>;
  recoveryCodes: string[];
  regenerateRecoveryCodes: () => Promise<void>;
  confirmRecoveryCodes: () => Promise<void>;
  addPasskey: (name: string) => Promise<void>;
  removePasskey: (id: string) => Promise<void>;
} {
  const submit = useSubmit();
  const [authorization, setAuthorization] = useState(initialAuthorization);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [generationId, setGenerationId] = useState("");
  async function perform(
    operation: SensitiveOperation,
    target: string | null,
    work: () => Promise<void>,
    consume = true,
  ): Promise<void> {
    const authorize = (): void => {
      submit(
        { operation, ...(target ? { target } : {}) },
        { method: "post", action: "/auth/manage" },
      );
    };
    if (
      authorization?.operation !== operation ||
      authorization.target !== target ||
      authorization.expiresAt <= Date.now()
    ) {
      authorize();
      return;
    }
    setBusy(true);
    setError("");
    try {
      await work();
      if (consume) setAuthorization(null);
    } catch (cause) {
      if (
        (cause as { details?: { code?: string } } | null)?.details?.code ===
        "SENSITIVE_AUTH_REQUIRED"
      ) {
        authorize();
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
  async function changePassword(
    password: string,
    confirmation: string,
  ): Promise<void> {
    if (password !== confirmation) {
      setError("Passwords do not match");
      return;
    }
    await perform("change-password", null, async () => {
      const result = await authClient.changePassword({
        currentPassword: "",
        newPassword: password,
        revokeOtherSessions: true,
      });
      ifErrorThrow(result);
      window.location.assign("/auth/manage");
    });
  }
  function regenerateRecoveryCodes(): Promise<void> {
    return perform(
      "generate-recovery-codes",
      null,
      async () => {
        const result = await authClient.$fetch<{
          backupCodes: string[];
          generationId: string;
        }>("/two-factor/generate-backup-codes", {
          method: "POST",
          body: { password: "" },
        });
        ifErrorThrow(result);
        setRecoveryCodes(result.data.backupCodes);
        setGenerationId(result.data.generationId);
      },
      false,
    );
  }
  function confirmRecoveryCodes(): Promise<void> {
    return perform("generate-recovery-codes", null, async () => {
      const response = await fetch("/auth/recovery-codes", {
        method: "POST",
        body: new URLSearchParams({ generationId }),
      });
      const result = (await response.json()) as {
        error: { message?: string; code?: string } | null;
      };
      ifErrorThrow(result);
      window.location.assign("/auth/manage");
    });
  }
  function addPasskey(name: string): Promise<void> {
    return perform("add-passkey", null, async () => {
      await registerPasskey(name);
      window.location.assign("/auth/manage");
    });
  }
  function removePasskey(id: string): Promise<void> {
    return perform("remove-passkey", id, async () => {
      const result = await authClient.passkey.deletePasskey({ id });
      ifErrorThrow(result);
      window.location.assign("/auth/manage");
    });
  }
  return {
    busy,
    error,
    changePassword,
    recoveryCodes,
    regenerateRecoveryCodes,
    confirmRecoveryCodes,
    addPasskey,
    removePasskey,
  };
}
