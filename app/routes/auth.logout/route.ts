import { redirect, type ActionFunctionArgs } from "@remix-run/node";
import { logout } from "../../services/auth/auth.server";

export const loader = (): Response => redirect("/auth/manage");
export const action = ({ request }: ActionFunctionArgs): Promise<Response> =>
  logout(request);
