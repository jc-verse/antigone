import type {
  LoaderFunctionArgs,
  ActionFunctionArgs,
  MetaFunction,
} from "@remix-run/node";
import {
  beginSensitiveLogin,
  requireOwnerSession,
  type AuthState,
} from "../../services/auth/auth.server";

export { default } from "./Manage";
export function loader({ request }: LoaderFunctionArgs): Promise<AuthState> {
  return requireOwnerSession(request);
}
export function action({
  request,
}: ActionFunctionArgs): Promise<Response> {
  return beginSensitiveLogin(request);
}
export const meta: MetaFunction = () => [
  { title: "Authentication · Antigone" },
];
