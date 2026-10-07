import {
  redirect,
  type LoaderFunctionArgs,
  type MetaFunction,
} from "@remix-run/node";
import {
  getAuthState,
  getSensitiveLoginIntent,
} from "../../services/auth/auth.server";
import {
  isSetupAuthorization,
  type SensitiveAuthorization,
} from "../../services/auth/sensitive-authorization";

export { default } from "./Login";

export async function loader({
  request,
}: LoaderFunctionArgs): Promise<{
  initialSetup: boolean;
  hasPasskey: boolean;
  redirectTo: string;
  sensitiveIntent: SensitiveAuthorization | null;
}> {
  const redirectTo =
    new URL(request.url).searchParams.get("redirectTo") === "/auth/manage"
      ? "/auth/manage"
      : "/";
  const { status, passkeys } = await getAuthState(request);
  if (isSetupAuthorization(status)) throw redirect("/auth/onboard");
  if (status === "authenticated" || typeof status === "object")
    throw redirect(redirectTo === "/" ? "/create" : redirectTo);
  const sensitiveIntent = await getSensitiveLoginIntent(request);
  return {
    initialSetup: status === "uninitialized",
    hasPasskey: passkeys.length > 0,
    redirectTo,
    sensitiveIntent,
  };
}

export const meta: MetaFunction = () => [{ title: "Sign in · Antigone" }];
