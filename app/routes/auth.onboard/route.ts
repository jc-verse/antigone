import {
  redirect,
  type LoaderFunctionArgs,
  type ActionFunctionArgs,
  type MetaFunction,
} from "@remix-run/node";
import {
  getAuthState,
  skipOnboardingPasskey,
  type AuthState,
} from "../../services/auth/auth.server";
import {
  isSetupAuthorization,
  type SensitiveAuthorization,
} from "../../services/auth/sensitive-authorization";

export { default } from "./Onboard";

export const action = ({ request }: ActionFunctionArgs): Promise<Response> =>
  skipOnboardingPasskey(request);

export async function loader({
  request,
}: LoaderFunctionArgs): Promise<
  Omit<AuthState, "status"> & { status: SensitiveAuthorization }
> {
  const state = await getAuthState(request);
  if (state.status === "unauthenticated" || state.status === "uninitialized")
    throw redirect("/auth/login");
  if (
    typeof state.status !== "object" ||
    (state.status.operation !== "add-passkey" &&
      !isSetupAuthorization(state.status))
  )
    throw redirect("/auth/manage");
  return { ...state, status: state.status };
}

export const meta: MetaFunction = () => [
  { title: "Set up your account · Antigone" },
];
